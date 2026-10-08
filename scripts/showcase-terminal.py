"""Live node stdout, collected over authenticated SSH; no generated execution events."""
import argparse
from collections import deque
import json
from pathlib import Path
import time
import urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('--host',choices=['hpc','mnckoren','ai-cloud','request'],required=True)
parser.add_argument('--live-only',action='store_true')
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
roles={'hpc':'CENTRAL ORCHESTRATOR','mnckoren':'PRIMARY AGENTS : tech/data/security/legal/policy/finance/procurement/operations',
       'ai-cloud':'BACKUP AGENTS : tech/data/security/legal/policy/finance/procurement/operations'}
if args.host=='request':
    base='http://127.0.0.1:36100'
    print('PUBLIC DEMO REQUEST -> HPC -> REMOTE AGENTS',flush=True)
    query='공공부문 AI 도입 가이드(2026.5.)에서 RAG 도구의 파싱, 청킹, 임베딩, 검색 API 구성은 어떻게 설명하나요? 제공된 공개 근거에 있는 내용만 요약해 주세요.'
    req=urllib.request.Request(base+'/api/runs',data=json.dumps({'query':query,'mode':'proposed','commercialJudge':False}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=15) as response: accepted=json.load(response)
    request_id=accepted['requestId'];print('REQUEST '+request_id+' | proposed | LIVE',flush=True)
    start=time.monotonic();previous=None
    while time.monotonic()-start<180:
        with urllib.request.urlopen(base+'/api/runs/'+request_id,timeout=15) as response: snapshot=json.load(response)
        progress={'requestId':request_id,'status':snapshot['status'],'progress':snapshot.get('progress')}
        if progress!=previous: print(json.dumps(progress,ensure_ascii=False),flush=True);previous=progress
        if snapshot['status'] in ['completed','partial_failed','failed','cancelled'] and snapshot.get('executionSettled'):
            dest=root/'outputs/showcase-20261008/terminal-demo-run.json'
            dest.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2),encoding='utf8')
            print('FINAL '+snapshot['status']+' | '+request_id+' | saved '+str(dest),flush=True);break
        time.sleep(.5)
    else:
        urllib.request.urlopen(urllib.request.Request(base+'/api/runs/'+request_id,method='DELETE'),timeout=15).close()
        raise RuntimeError('Known demo request timed out and was cancelled')
    input('Demo complete. Press Enter to close this request console. ')
else:
    print(args.host.upper()+' | '+roles[args.host],flush=True)
    print('SOURCE: authenticated SSH -> node process stdout -> local collector',flush=True)
    print('Recent recorded events below; LIVE marker separates new events. Idle is normal.',flush=True)
    path=root/'.local-monitor/remote-live.log'
    def display(line):
        try: row=json.loads(line)
        except ValueError: return
        if row.get('schema')!='execution-log/v1' or row.get('host')!=args.host: return
        print(f"{row.get('timestamp','')}  {row.get('event','')}  {row.get('agentId','Core')}  {row.get('status','')}  {row.get('elapsedMs','-')}ms\n  request={row.get('requestId','-')}  node={row.get('nodeId','-')}\n  attempt={row.get('attemptId','-')}",flush=True)
    with path.open(encoding='utf8',errors='replace') as stream:
        recent=deque(stream,maxlen=400)
        matched=[]
        for line in recent:
            try: row=json.loads(line)
            except ValueError: continue
            if row.get('host')==args.host and row.get('schema')=='execution-log/v1': matched.append(line)
        if not args.live_only:
            for line in matched[-8:]: display(line)
        print('\n========== LIVE NODE STDOUT : WAITING FOR NEW EVENTS ==========\n',flush=True)
        while True:
            line=stream.readline()
            if line: display(line)
            else: time.sleep(.2)
