"""Run on HPC only. Sequential paired pilot; faults affect only the showcase gateway."""
import hashlib
import json
import math
from pathlib import Path
import random
import socket
import time
import urllib.request
import uuid

root=Path.home()/'axnetcc-showcase-20261008'
shared=root/'shared'
config=json.loads((shared/'operator.json').read_text())
gateway=json.loads((shared/'gateway.json').read_text())
base='http://127.0.0.1:36101'
terminal={'completed','partial_failed','failed','cancelled'}
methods=['centralized','parallel','managed','masrouter','remoterag','proposed']
fixtures=json.loads((root/'release/data/evaluation/distributed-demo-fixtures.json').read_text())['fixtures'][:2]
plan=[]
for scenario in ['healthy','primary-delay-300','primary-down']:
    for occurrence,fixture in enumerate(fixtures):
        order=methods.copy();random.Random(20261008+occurrence).shuffle(order)
        plan.extend({'method':method,'scenario':scenario,'fixture':fixture,'occurrence':occurrence+1} for method in order)
plan.extend({'method':'proposed','scenario':scenario,'fixture':fixtures[0],'occurrence':1} for scenario in ['both-down','restored-primary'])
manifest={'deploymentId':'showcase-20261008','startedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'seed':20261008,
          'plannedCount':len(plan),'concurrency':1,'methods':methods,'scenarios':['healthy','primary-delay-300','primary-down','both-down','restored-primary'],
          'workloadSha256':hashlib.sha256(json.dumps(fixtures,sort_keys=True).encode()).hexdigest(),
          'topology':{'core':'HPC-VM','primary':'mnckoren','backup':'ai-cloud'},
          'inferenceResources':'dedicated showcase Ollama14434 on all three nodes; existing model files read without downloads',
          'networkSemantics':'HPC direct TCP connect plus observed Core/Edge body sizes; fixed300ms gateway delay is application injection, not link impairment',
          'quality':'No semantic grading; small paired execution pilot, not a general benchmark',
          'resetPolicy':'After any uncertain inference completion stop admission, prove dedicated process group termination on all nodes, restart and warm before next sample; failures remain in cohort',
          'timeoutMs':120000,'warmupExcluded':True,'rendering':'source-grounded-generation','model':'qwen3:4b-instruct-2507-q4_K_M'}
report={'schema':'distributed-showcase/v1','manifest':manifest,'samples':[],'state':'running','stopReason':None}
if (shared/'manifest.json').exists():
    raise RuntimeError('Existing campaign artifacts must not be overwritten')
(shared/'manifest.json').write_text(json.dumps(manifest,indent=2))

def save():
    temp=shared/'campaign.json.tmp';temp.write_text(json.dumps(report,ensure_ascii=False,indent=2));temp.replace(shared/'campaign.json')

def request(path,method='GET',body=None,token=None,timeout=15,endpoint=base):
    headers={'content-type':'application/json'}
    if token:headers['authorization']='Bearer '+token
    req=urllib.request.Request(endpoint+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=timeout) as response:return json.load(response)

def fault(scenario):
    value='healthy' if scenario=='restored-primary' else scenario
    return request('/fault','POST',{'scenario':value,'agentId':'all','ttlMs':180000},gateway['controlToken'],endpoint='http://127.0.0.1:20444')

def probes():
    rows=[]
    for name,host,port in [('mnckoren-ssh','210.114.95.58',22),('ai-cloud-ssh','116.89.177.90',31055)]:
        start=time.perf_counter()
        try:
            connection=socket.create_connection((host,port),2);connection.close();duration=(time.perf_counter()-start)*1000
        except OSError:duration=None
        rows.append({'nodeId':name,'connectMs':duration,'timestamp':int(time.time()*1000)})
    return rows

def mean(values):
    valid=[value for value in values if isinstance(value,(int,float)) and math.isfinite(value) and value>=0]
    return sum(valid)/len(valid) if valid else None

active=None
save()
try:
    health=request('/api/health')
    if health.get('scheduler',{}).get('activeCount',0) or health.get('scheduler',{}).get('queueDepth',0):
        raise RuntimeError('Showcase scheduler is not idle')
    for index,item in enumerate(plan):
        fault(item['scenario'])
        network=probes()
        start=time.monotonic()
        accepted=request('/api/runs','POST',{'query':item['fixture']['query'],'mode':item['method'],'commercialJudge':False},config['DEMO_OPERATOR_TOKEN'])
        active=accepted['requestId']
        row={'method':item['method'],'scenario':item['scenario'],'fixtureId':item['fixture']['id'],'occurrence':item['occurrence'],
             'requestId':active,'network':network,'tcpConnectMs':mean([v['connectMs'] for v in network]),'startedAt':int(time.time()*1000)}
        print(json.dumps({'sample':index+1,'planned':len(plan),**{k:row[k] for k in ['method','scenario','requestId']}}),flush=True)
        snapshot=None
        while time.monotonic()-start<135:
            snapshot=request('/api/runs/'+active,token=config['DEMO_OPERATOR_TOKEN'])
            if snapshot['status'] in terminal and snapshot.get('executionSettled') is True:break
            time.sleep(.3)
        if not snapshot or snapshot['status'] not in terminal or not snapshot.get('executionSettled'):
            request('/api/runs/'+active,'DELETE',token=config['DEMO_OPERATOR_TOKEN'])
            row.update({'status':'timeout','elapsedMs':(time.monotonic()-start)*1000,'realInference':False})
            report['samples'].append(row);save();raise RuntimeError('Timeout: stop admission; dedicated model reset required before another campaign')
        row.update({'status':snapshot['status'],'elapsedMs':(time.monotonic()-start)*1000})
        telemetry=request('/api/telemetry',token=config.get('MONITOR_SCRAPE_TOKEN'))
        observed=next((run for run in telemetry.get('runs',[]) if run.get('runId')==active),None)
        distributed=(observed or {}).get('distributed') or {}
        attempts=distributed.get('attempts',[]);calls=distributed.get('calls',[])
        participants=[a for a in attempts if a.get('adopted') and a.get('usageStatus')!='not-started']+calls
        row['realInference']=bool(participants) and all(a.get('backend')=='ollama' and a.get('status')=='succeeded' for a in participants)
        for key in ['ttftMs','tpotMs','tokensPerSecond']:row[key]=mean([a.get(key) for a in participants])
        totals=distributed.get('totals',{})
        row.update({'requestBytes':totals.get('requestBytesPrepared'),'responseBytes':totals.get('responseBytesReceived'),
                    'promptTokens':totals.get('promptTokens'),'completionTokens':totals.get('completionTokens'),'instanceId':telemetry.get('instanceId'),
                    'distributed':distributed,'providerTimingSemantics':'mean participating physical provider calls; TPS inverse measured TPOT for Edge, provider counter rate for Core',
                    'executionSettled':True})
        (shared/(active+'.json')).write_text(json.dumps(snapshot,ensure_ascii=False))
        with (shared/'samples.jsonl').open('a') as output:output.write(json.dumps(row,ensure_ascii=False)+'\n')
        report['samples'].append(row);save();active=None
        print(json.dumps({'sample':index+1,'status':row['status'],'elapsedMs':round(row['elapsedMs']),'realInference':row['realInference']}),flush=True)
        # Ambiguous in-flight inference invalidates continued testing; gateway typed faults never entered inference.
        unsafe=[a for a in attempts if a.get('status')!='succeeded' and a.get('reasonCode') not in ['edge-unavailable','http-503'] and a.get('usageStatus')!='not-started']
        if unsafe or any(c.get('status')!='succeeded' for c in calls):
            resetId=str(uuid.uuid4())
            (shared/'reset-request.json').write_text(json.dumps({'id':resetId,'requestId':row['requestId']}))
            print(json.dumps({'pausedAdmission':True,'resetId':resetId,'reason':'uncertain-provider-completion'}),flush=True)
            deadline=time.monotonic()+120
            receipt=None
            while time.monotonic()<deadline:
                p=shared/'reset-receipt.json'
                if p.exists():
                    candidate=json.loads(p.read_text())
                    if candidate.get('id')==resetId:receipt=candidate;break
                time.sleep(1)
            if receipt is None:raise RuntimeError('Dedicated model reset unproven; no continued admission')
            row['resetAfterSample']=receipt
            with (shared/'resets.jsonl').open('a') as output:output.write(json.dumps(receipt)+'\n')
            save()
    report['state']='completed'
except Exception as error:
    report['state']='partial';report['stopReason']=type(error).__name__+': '+str(error)
    if active:
        try:request('/api/runs/'+active,'DELETE',token=config['DEMO_OPERATOR_TOKEN'])
        except Exception:pass
finally:
    try:
        fault('healthy');state=request('/fault',token=gateway['controlToken'],endpoint='http://127.0.0.1:20444')
        report['faultRestored']=state.get('scenario')=='healthy'
    except Exception:report['faultRestored']=False
    report['finishedAt']=int(time.time()*1000);save()
    print(json.dumps({'campaignState':report['state'],'samples':len(report['samples']),'planned':len(plan),'stopReason':report['stopReason'],'faultRestored':report['faultRestored']}),flush=True)
