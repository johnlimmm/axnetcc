"""Local demo frontend with explicit operator routing to real local or HPC APIs."""
import json,threading,time,urllib.request,urllib.error
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
root=Path(__file__).resolve().parents[1]
receipt=root/'outputs/video-production/browser-request-receipts.jsonl'
state={'backend':'local'};lock=threading.Lock()
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def do_GET(self):self.forward()
 def do_DELETE(self):self.forward()
 def do_POST(self):
  if self.path=='/__demo/route':
   value=json.loads(self.rfile.read(int(self.headers.get('content-length',0))))
   if value.get('backend') not in ['local','remote']:self.send_error(400);return
   with lock:state['backend']=value['backend']
   body=json.dumps(state).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
  self.forward()
 def forward(self):
  with lock:backend=state['backend']
  base='http://127.0.0.1:36100' if self.path.startswith('/api/') and backend=='remote' else 'http://127.0.0.1:3100'
  data=self.rfile.read(int(self.headers.get('content-length',0))) if self.command=='POST' else None
  headers={key:value for key,value in self.headers.items() if key.lower() not in ['host','connection','accept-encoding','content-length']}
  req=urllib.request.Request(base+self.path,data=data,headers=headers,method=self.command)
  try:
   try:upstream=urllib.request.urlopen(req,timeout=120)
   except urllib.error.HTTPError as error:upstream=error
   self.send_response(upstream.status)
   for key,value in upstream.headers.items():
    if key.lower() not in ['transfer-encoding','connection','keep-alive','content-length']:self.send_header(key,value)
   self.send_header('Connection','close');self.end_headers();self.close_connection=True
   chunks=[]
   while True:
    chunk=upstream.read1(65536)
    if not chunk:break
    self.wfile.write(chunk);self.wfile.flush()
    if self.command=='POST' and self.path=='/api/runs':chunks.append(chunk)
   if chunks:
    payload=json.loads(b''.join(chunks));request_id=payload.get('requestId')
    if request_id:
     with lock:
      with receipt.open('a',encoding='utf8') as file:file.write(json.dumps(dict(at=time.time(),backend=backend,requestId=request_id))+'\n')
   upstream.close()
  except (BrokenPipeError,ConnectionResetError):pass
  except Exception as error:
   print(json.dumps(dict(proxyError=type(error).__name__,path=self.path)),flush=True)
ThreadingHTTPServer(('127.0.0.1',36300),Handler).serve_forever()
