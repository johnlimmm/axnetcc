import json
from pathlib import Path
import time
import urllib.request

base='http://127.0.0.1:3100'
output=Path(__file__).resolve().parents[1]/'outputs/showcase-20261008'
output.mkdir(exist_ok=True,parents=True)
query='공공부문 AI 도입 가이드(2026.5.)에서 RAG 도구의 파싱, 청킹, 임베딩, 검색 API 구성은 어떻게 설명하나요? 제공된 공개 근거에 있는 내용만 요약해 주세요.'
request=urllib.request.Request(base+'/api/runs',data=json.dumps({'query':query,'mode':'proposed','commercialJudge':False}).encode(),headers={'content-type':'application/json'},method='POST')
with urllib.request.urlopen(request,timeout=10) as response:accepted=json.load(response)
requestId=accepted['requestId'];start=time.monotonic();last=None
while time.monotonic()-start<180:
    with urllib.request.urlopen(base+'/api/runs/'+requestId,timeout=10) as response:snapshot=json.load(response)
    progress={'requestId':requestId,'status':snapshot['status'],'progress':snapshot.get('progress')}
    if progress!=last:print(json.dumps(progress,ensure_ascii=True),flush=True);last=progress
    if snapshot['status'] in ['completed','partial_failed','failed','cancelled'] and snapshot.get('executionSettled'):
        (output/'local-showcase.json').write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'localRun':requestId,'status':snapshot['status'],'elapsedMs':round((time.monotonic()-start)*1000),'snapshotFile':str(output/'local-showcase.json')}),flush=True)
        break
    time.sleep(.5)
else:
    urllib.request.urlopen(urllib.request.Request(base+'/api/runs/'+requestId,method='DELETE'),timeout=10).close()
    raise RuntimeError('Local demo timed out; cancelled known run')
