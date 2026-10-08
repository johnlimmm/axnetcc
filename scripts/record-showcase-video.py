"""Continuous silent screen capture of owned demo windows, with actual API execution."""
import argparse
import base64
import ctypes
from ctypes import wintypes
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'outputs/video-production'
sys.path.insert(0,str(ROOT/'outputs/video-review-tools'))
import imageio_ffmpeg
import websocket

USER=ctypes.windll.user32
USER.SetProcessDPIAware()
USER.GetWindowTextW.argtypes=[wintypes.HWND,wintypes.LPWSTR,ctypes.c_int]
USER.SetWindowPos.argtypes=[wintypes.HWND,wintypes.HWND,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_uint]
USER.ShowWindow.argtypes=[wintypes.HWND,ctypes.c_int]
USER.SetForegroundWindow.argtypes=[wintypes.HWND]
CALLBACK=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
def windows():
    rows=[]
    @CALLBACK
    def collect(handle,_):
        if USER.IsWindowVisible(handle):
            buffer=ctypes.create_unicode_buffer(512);USER.GetWindowTextW(handle,buffer,512)
            if buffer.value:rows.append((handle,buffer.value))
        return True
    USER.EnumWindows(collect,0)
    return rows
def move(title,x,y,width,height,top=True):
    matches=[]
    for _ in range(30):
        matches=[handle for handle,name in windows() if title in name]
        if matches:break
        time.sleep(.1)
    if not matches:raise RuntimeError('Owned recording window not found: '+title)
    handle=matches[-1];USER.ShowWindow(handle,9)
    USER.SetWindowPos(handle,-1 if top else -2,x,y,width,height,0x0040)
    USER.SetForegroundWindow(handle)
    return handle
def read(url):
    with urllib.request.urlopen(url,timeout=15) as response:return json.load(response)
class Browser:
    def __init__(self):
        page=next(p for p in read('http://127.0.0.1:9229/json/list') if p['type']=='page')
        self.target_id=page['id']
        self.title='AXNetCC LIVE '+page['id'][:10]
        self.socket=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=30,suppress_origin=True)
        self.sequence=0
    def call(self,method,params=None):
        self.sequence+=1;seq=self.sequence
        self.socket.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
        while True:
            message=json.loads(self.socket.recv())
            if message.get('id')==seq:
                if 'error' in message:raise RuntimeError(str(message['error']))
                return message.get('result',{})
    def js(self,expression):
        result=self.call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
        if result.get('exceptionDetails'):raise RuntimeError(str(result['exceptionDetails']))
        return result.get('result',{}).get('value')
    def navigate(self,url):
        navigation=self.call('Page.navigate',{'url':url})
        if navigation.get('errorText'):raise RuntimeError(navigation['errorText'])
        for _ in range(60):
            try:
                if self.js('location.href')==url and self.js('document.readyState')=='complete':break
            except RuntimeError:pass
            time.sleep(.25)
        else:raise RuntimeError('Owned demo page did not finish navigation')
        self.js('document.title='+json.dumps(self.title)+";document.documentElement.style.zoom='100%'")
        move(self.title,0,0,1920,1080)
    def shot(self,name):
        image=self.call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})
        (OUT/(name+'.png')).write_bytes(base64.b64decode(image['data']))

TITLES=['DEMO HPC | CENTRAL ORCHESTRATOR','DEMO MNCKOREN | PRIMARY AGENTS','DEMO AI-CLOUD | BACKUP AGENTS','DEMO REQUEST | ACTUAL EXECUTION']
def prepare():
    OUT.mkdir(exist_ok=True,parents=True)
    for handle,title in windows():
        if any(title == owned for owned in TITLES):USER.PostMessageW(handle,0x0010,0,0)
    time.sleep(1)
    (OUT/'actions.log').write_text('',encoding='utf8')
    try:browser=Browser()
    except Exception:
        subprocess.Popen([r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            '--user-data-dir='+str(ROOT/'.local-monitor/video-browser'),'--remote-debugging-port=9229',
            '--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check',
            '--app=http://127.0.0.1:3100/','--window-position=0,0','--window-size=1920,1080'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(40):
        try:browser=Browser();break
        except Exception:time.sleep(.5)
    else:raise RuntimeError('Dedicated browser did not start')
    for page in read('http://127.0.0.1:9229/json/list'):
        if page.get('type')=='page' and page['id']!=browser.target_id and page.get('title','').startswith('AXNetCC ') and page.get('url','').startswith(('http://127.0.0.1:3100/','http://127.0.0.1:36200/')):
            browser.call('Target.closeTarget',{'targetId':page['id']})
    browser.navigate('http://127.0.0.1:3100/')
    colors=['#efbd39','#28c788','#36a8ef','#ed6689']
    for i,title in enumerate(TITLES):
        script='video-request-console.py' if i==3 else 'showcase-terminal.py'
        extra=[] if i==3 else ['--host',['hpc','mnckoren','ai-cloud'][i],'--live-only']
        subprocess.run(['wt.exe','-w','new','--pos',f'{(i%2)*960},{(i//2)*540}','--size','100,27',
            'new-tab','--title',title,'--tabColor',colors[i],'--suppressApplicationTitle','-d',str(ROOT),
            sys.executable,'-u',str(ROOT/'scripts'/script),*extra],check=True)
        time.sleep(1)
    for i,title in enumerate(TITLES):move(title,(i%2)*960,(i//2)*540,960,540,False)
    browser.navigate('http://127.0.0.1:3100/')
    browser.shot('prepared-service')
    (OUT/'prepared.json').write_text(json.dumps({'titles':TITLES,'captureRect':[0,0,1920,1080],'audio':False}),encoding='utf8')
    print(json.dumps({'prepared':True,'windows':4,'audio':False}),flush=True)

def action(text):
    line=time.strftime('%H:%M:%S')+'  '+text
    with (OUT/'actions.log').open('a',encoding='utf8') as stream:stream.write(line+'\n')
    print(line,flush=True)
def remote_script(name,credentials):
    result=subprocess.run([sys.executable,str(ROOT/'scripts/remote-demo-control.py'),'run','--script','scripts/'+name,
        '--hosts','hpc','--credential-session',credentials],cwd=ROOT,capture_output=True,text=True,timeout=45)
    if result.returncode:raise RuntimeError('Dedicated remote action failed: '+name)
    rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
    if any(row.get('exitCode',0)!=0 for row in rows):raise RuntimeError('Remote script failed: '+name)
    action('CONTROL '+name+' | acknowledged')

def submit(base,query):
    req=urllib.request.Request(base+'/api/runs',data=json.dumps({'query':query,'mode':'proposed','commercialJudge':False}).encode(),headers={'content-type':'application/json'})
    with urllib.request.urlopen(req,timeout=15) as response:accepted=json.load(response)
    request_id=accepted['requestId'];action('POST '+base+'/api/runs -> '+request_id)
    return request_id
def observe(base,request_id,seconds):
    deadline=time.monotonic()+seconds;last=None
    while time.monotonic()<deadline:
        snapshot=read(base+'/api/runs/'+request_id)
        status=snapshot['status'];progress=snapshot.get('progress',{})
        identity=json.dumps([status,progress],sort_keys=True)
        if identity!=last:action(request_id+' | '+status+' | '+json.dumps(progress,ensure_ascii=True));last=identity
        if status in ['completed','partial_failed','failed','cancelled'] and snapshot.get('executionSettled'):
            (OUT/(request_id+'.json')).write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf8')
            action('FINAL '+request_id+' | '+status);return snapshot
        time.sleep(.5)
    action('STILL RUNNING '+request_id+' | no fabricated completion');return None
def panels():
    for i,title in enumerate(TITLES):move(title,(i%2)*960,(i//2)*540,960,540)
def show_comparison(browser,scenario,metric):
    for _ in range(60):
        if browser.js('!!document.querySelector("#campaign-scenario")'):break
        time.sleep(.5)
    else:raise RuntimeError('Measured campaign controls unavailable')
    browser.js('document.title='+json.dumps(browser.title))
    move(browser.title,0,0,1920,1080)
    browser.js('(()=>{const scenario=document.querySelector("#campaign-scenario");scenario.value='+json.dumps(scenario)+
        ';scenario.dispatchEvent(new Event("change",{bubbles:true}));const metric=document.querySelector("#campaign-metric");metric.value='+json.dumps(metric)+
        ';metric.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("[data-testid=campaign-comparison]").scrollIntoView({block:"start"});})()')
    action('MEASURED COHORT | '+scenario+' | '+metric)

def record(credentials):
    browser=Browser();browser.navigate('http://127.0.0.1:3100/')
    for title in TITLES:move(title,2200,100,960,540,False)
    browser.navigate('http://127.0.0.1:3100/')
    final=Path(r'C:\Users\Daesik\Dropbox\26-3Q 여름방학\넷 챌린지\최종평가시연동영상_MNC Lab.mp4')
    if final.exists():raise RuntimeError('Refuse to overwrite existing final video')
    capture=OUT/'silent-demo-capture.mp4'
    log=(OUT/'ffmpeg-recording.log').open('wb')
    ffmpeg=subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(),'-y','-f','gdigrab','-framerate','15','-offset_x','0','-offset_y','0',
        '-video_size','1920x1080','-draw_mouse','0','-i','desktop','-t','285','-an','-c:v','libx264','-preset','veryfast','-crf','23',
        '-pix_fmt','yuv420p','-movflags','+faststart',str(capture)],stdin=subprocess.PIPE,stdout=log,stderr=log)
    started=time.monotonic();requests=[]
    try:
        action('RECORDING | silent continuous screen capture | no overlays or transitions')
        query='공공부문 AI 도입 가이드(2026.5.)에서 RAG 도구의 파싱 단계는 무엇인가요? 공개 근거만 간단히 설명해 주세요.'
        browser.js('(()=>{const t=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,'+json.dumps(query)+');t.dispatchEvent(new Event("input",{bubbles:true}));})()')
        time.sleep(5)
        request_id=submit('http://127.0.0.1:3100',query);requests.append(('local',request_id))
        browser.navigate('http://127.0.0.1:3100/?run='+request_id)
        observe('http://127.0.0.1:3100',request_id,70)
        browser.shot('local-result');browser.js('document.querySelector("#final-result-title")?.scrollIntoView({block:"start"})');time.sleep(6)
        panels();time.sleep(3)
        request_id=submit('http://127.0.0.1:36100',query);requests.append(('distributed',request_id))
        observe('http://127.0.0.1:36100',request_id,35);time.sleep(4)
        remote_script('video-backup-fault.py',credentials)
        request_id=submit('http://127.0.0.1:36100',query);requests.append(('backup',request_id))
        observe('http://127.0.0.1:36100',request_id,70)
        remote_script('video-restore-fault.py',credentials);time.sleep(5)
        for title in TITLES:move(title,2200,100,960,540,False)
        browser.navigate('http://127.0.0.1:36200/distributed?window=24h')
        time.sleep(3)
        for scenario,metric in [('healthy','p50Ms'),('healthy','ttftMs'),('healthy','tpotMs'),('healthy','tokensPerSecond'),
                                ('primary-delay-300','p95Ms'),('primary-down','p95Ms'),('primary-down','tokensPerSecond')]:
            show_comparison(browser,scenario,metric);time.sleep(7)
        browser.shot('comparison-primary-down')
        browser.js('document.querySelector("[data-testid=network-performance]").scrollIntoView({block:"start"})');time.sleep(10)
        browser.shot('network-live')
        browser.js('document.querySelector("[data-testid=distributed-performance]")?.scrollIntoView({block:"start"})');time.sleep(8)
        action('DEMO END | original 38-sample cohort preserved | audio absent')
    finally:
        try:remote_script('video-restore-fault.py',credentials)
        except Exception as error:action('RESTORE CHECK '+type(error).__name__)
        if ffmpeg.poll() is None:
            ffmpeg.stdin.write(b'q\n');ffmpeg.stdin.flush()
        ffmpeg.wait(timeout=40);log.close()
    if ffmpeg.returncode:raise RuntimeError('Recording failed; inspect dedicated encoder log')
    elapsed=time.monotonic()-started
    if elapsed>300:action('Wall-clock workflow exceeded video budget; encoded duration requires validation')
    receipt={'capture':str(capture),'requests':requests,'audio':False,'overlays':False,'continuousCapture':True,'wallSeconds':elapsed,'finalTarget':str(final)}
    (OUT/'recording-receipt.json').write_text(json.dumps(receipt,indent=2),encoding='utf8')
    print(json.dumps(receipt),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','record','check','inspect']);parser.add_argument('--credential-session')
    args=parser.parse_args()
    if args.action=='prepare':prepare()
    elif args.action=='inspect':
        browser=Browser()
        print(json.dumps({'targets':[{k:p.get(k) for k in ['id','title','url']} for p in read('http://127.0.0.1:9229/json/list') if p['type']=='page'],
            'actual':browser.js('({url:location.href,title:document.title,text:document.body.innerText.slice(0,1200),campaign:!!document.querySelector("#campaign-scenario")})')},ensure_ascii=True),flush=True)
        browser.shot('diagnostic-browser')
    elif args.action=='check':
        browser=Browser();browser.navigate('http://127.0.0.1:36200/distributed?window=24h');time.sleep(4)
        show_comparison(browser,'primary-down','tokensPerSecond');browser.shot('comparison-preview')
        subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-f','gdigrab','-offset_x','0','-offset_y','0',
            '-video_size','1920x1080','-i','desktop','-frames:v','1',str(OUT/'visible-comparison-preview.png')],check=True)
        capture=OUT/'silent-demo-capture.mp4'
        if capture.exists():
            number=1
            while (OUT/f'silent-demo-capture-take{number}.mp4').exists():number+=1
            capture.rename(OUT/f'silent-demo-capture-take{number}.mp4')
        print(json.dumps({'comparisonControlsVerified':True}),flush=True)
    else:record(args.credential_session)
