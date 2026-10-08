"""Resumable 24h local LLM measurement. Repetitions are not independent test cases."""
import argparse, hashlib, importlib.util, json, os, random, statistics, subprocess, sys, time
from pathlib import Path
from urllib.request import Request, urlopen
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports/local-evaluation'
MODES=['centralized','managed','parallel','proposed']
sys.stdout.reconfigure(encoding='utf8')

def now(): return datetime.now(timezone.utc).isoformat()
def atomic(path,obj):
    tmp=path.with_suffix(path.suffix+'.tmp'); tmp.write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf8'); os.replace(tmp,path)
def request(base,path,body=None,method=None,idempotency=None):
    headers={'content-type':'application/json'}
    if idempotency:headers['idempotency-key']=idempotency
    req=Request(base+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    with urlopen(req,timeout=20) as r:return json.load(r)
def mean(values):
    values=[v for v in values if isinstance(v,(float,int))]
    return statistics.mean(values) if values else None

def inference_classification(result):
    selected=[a for a in result.get('agents',[]) if a.get('selected')]
    metrics=result.get('metrics') or {}
    fallback=metrics.get('llmBackend')!='ollama' or any(
        a.get('inference',{}).get('answerSource')=='deterministic-fallback' and
        a.get('inference',{}).get('role')!='evidence-projection' for a in selected)
    return fallback, metrics.get('llmBackend')=='ollama' and not fallback

def provider_samples(result):
    samples=[]
    for agent in result.get('agents',[]):
        inf=agent.get('inference') or {}
        if agent.get('selected') and inf.get('backend')=='ollama':
            samples.append(dict(agentId=agent['id'],kind='agent',ttftMs=inf.get('ttftMs'),tpotMs=inf.get('tpotMs'),tokensPerSecond=inf.get('tokensPerSecond')))
    for stage in (result.get('metrics',{}).get('distributed') or {}).get('stages',[]):
        if stage.get('backend')=='ollama':
            samples.append(dict(agentId='core',kind='central',ttftMs=stage.get('ttftMs'),tpotMs=stage.get('tpotMs'),tokensPerSecond=stage.get('tokensPerSecond')))
    return samples

def measured_providers(result, telemetry):
    samples=provider_samples(result)
    for c in ((telemetry or {}).get('distributed') or {}).get('calls',[]):
        if c.get('backend')=='ollama':samples.append(dict(agentId='core',kind='central',ttftMs=c.get('ttftMs'),tpotMs=c.get('tpotMs'),tokensPerSecond=c.get('tokensPerSecond')))
    return samples

def complete_metrics(row):
    positive=lambda v:isinstance(v,(int,float)) and v>0
    providers=row.get('providerSamples') or []
    return row.get('status')=='completed' and row.get('realLlm') is True and all(positive(row.get(k)) for k in ['latencyMs','tpotMs','tokensPerSecond','completionTokens']) and isinstance(row.get('ttftMs'),(int,float)) and row['ttftMs']>=0 and len(providers)==row.get('calls') and len(providers)>0 and all(isinstance(p.get('ttftMs'),(int,float)) and p['ttftMs']>=0 and positive(p.get('tpotMs')) and positive(p.get('tokensPerSecond')) for p in providers)

def stopping_evidence(cases,records,target):
    counts=[];stable=0
    for case in cases:
        for mode in MODES:
            cell=[r['latencyMs'] for r in records if r['caseId']==case['id'] and r['mode']==mode and complete_metrics(r)]
            counts.append(len(cell))
            if len(cell)>=target and statistics.mean(cell)>0 and statistics.stdev(cell)/statistics.mean(cell)<=.25:stable+=1
    return dict(cells=len(counts),completeCells=sum(n>=target for n in counts),minimumValidPerCell=min(counts),targetPerCell=target,
        stableCells=stable,stableCellRatio=stable/len(counts),ready=all(n>=target for n in counts) and stable/len(counts)>=.8)

def health_signature(health):
    return dict(edgeMode=health.get('edgeMode'),model=health.get('model'),publicEvidenceOnly=health.get('publicEvidenceOnly'),agents=sorted([dict(id=a['id'],model=a.get('model'),transport=a.get('transport')) for a in health['agents']],key=lambda a:a['id']))

def summarize(manifest, records, status):
    rows=[]
    for mode in MODES:
        group=[r for r in records if r['mode']==mode]
        done=[r for r in group if r.get('status')=='completed']
        real=[r for r in done if complete_metrics(r)]
        providers=[p for r in real for p in r.get('providerSamples',[])]
        rows.append(dict(mode=mode,n=len(group),completed=len(done),uniqueQueries=len({r['caseId'] for r in group}),
            realLlmCompleted=sum(r.get('realLlm') is True for r in done),fallback=sum(r.get('fallback',False) for r in group),
            validSamples=len(real),
            latencyMs=mean([r.get('latencyMs') for r in real]),agentF1=mean([r.get('agentF1') for r in done]),
            calls=mean([r.get('calls') for r in real]),tokens=mean([r.get('completionTokens') for r in real]),
            measuredTokenSamples=sum(isinstance(r.get('completionTokens'),(int,float)) for r in real),
            ttftMs=mean([r.get('ttftMs') for r in real]),tpotMs=mean([r.get('tpotMs') for r in real]),
            tokensPerSecond=mean([r.get('tokensPerSecond') for r in real]),factCoverage=mean([r.get('factCoverage') for r in real]),
            factSamples=sum(isinstance(r.get('factCoverage'),(int,float)) for r in real),
            throughputProviderSamples=sum(isinstance(p.get('tokensPerSecond'),(int,float)) for p in providers),
            perQuery=[dict(caseId=cid,n=len(q:=[r for r in real if r['caseId']==cid]),latencyMs=mean([r.get('latencyMs') for r in q]),agentF1=mean([r.get('agentF1') for r in q])) for cid in sorted({r['caseId'] for r in group})]))
    return dict(status=status,sampleCount=len(records),startedAt=manifest['startedAt'],deadlineAt=manifest['deadlineAt'],updatedAt=now(),
        dataset=manifest['dataset'],environment=manifest['health'],rows=rows,stopping=manifest.get('stopping'),
        limitations=['Existing 40-question development dataset; repeated measurements are not independent questions.',
        'Identical local model endpoint; inference architecture differs by mode; report actual calls and fallback.',
        'F1 measures Agent set overlap, not semantic answer correctness. Completed is an execution state.',
        'Warm-up effects, output length, shared model queues and other PC workloads affect timings.'])

def run(args):
    assert args.min_valid>=2 and args.max_attempts>=args.min_valid
    if os.name=='nt':
        import ctypes
        ctypes.windll.kernel32.SetThreadExecutionState(0x80000001)
    OUT.mkdir(parents=True,exist_ok=True)
    lock=OUT/'runner.lock'
    try: fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    except FileExistsError: raise RuntimeError('Runner lock exists; inspect owner before recovery')
    os.write(fd,str(os.getpid()).encode()); os.close(fd)
    try:
        data=ROOT/'data/evaluation/ax-golden-set-40.jsonl'
        cases=[json.loads(v) for v in data.read_text(encoding='utf8').splitlines() if v.strip()]
        spec=importlib.util.spec_from_file_location('facts',ROOT/'scripts/public-fact-evaluation.py');facts=importlib.util.module_from_spec(spec);spec.loader.exec_module(facts)
        fact_cases,rubric_hash=facts.load_cases();cases+=fact_cases
        health=request(args.base,'/api/health')
        assert health.get('edgeMode')=='local' and health.get('connected')==8,health
        assert all(a.get('transport')=='local' for a in health['agents'])
        assert health.get('publicEvidenceOnly') is True,'Public-only evaluation service required'
        file=OUT/'manifest.json'
        manifest=json.loads(file.read_text(encoding='utf8')) if file.exists() else dict(startedAt=now(),
            deadlineAt=time.time()+args.hours*3600,base=args.base,health=health,seed=20261008,
            dataset=dict(path=str(data),sha256=hashlib.sha256(data.read_bytes()).hexdigest(),cases=len(cases),split='development'),
            modes=MODES,concurrency=1,caseOrder='seeded shuffled each round',modeOrder='seeded shuffled within each query block')
        if 'rubricHash' in manifest:assert manifest['rubricHash']==rubric_hash
        manifest.update(rubricHash=rubric_hash,publicEvidenceOnly=True,totalCases=len(cases),targetPerCell=args.min_valid)
        evaluator_hash=hashlib.sha256((ROOT/'scripts/public-fact-evaluation.py').read_bytes()).hexdigest()
        if 'evaluatorHash' in manifest:assert manifest['evaluatorHash']==evaluator_hash
        manifest['evaluatorHash']=evaluator_hash
        atomic(file,manifest)
        assert manifest['base']==args.base and manifest['dataset']['sha256']==hashlib.sha256(data.read_bytes()).hexdigest()
        assert manifest['modes']==MODES and health_signature(manifest['health'])==health_signature(health),'Model or Agent configuration changed; keep separate experiment'
        runtime=ROOT/'dist/server/index.js'
        runtime_hash=hashlib.sha256(runtime.read_bytes()).hexdigest()
        if 'runtimeHash' in manifest:assert manifest['runtimeHash']==runtime_hash,'Runtime changed; keep separate experiment'
        else:
            manifest.update(runtimeHash=runtime_hash,runtimeBindingAddedAt=now())
            atomic(file,manifest)
        journal=OUT/'measurements.jsonl'
        records=[]
        if journal.exists():
            for line in journal.read_text(encoding='utf8').splitlines():
                try: records.append(json.loads(line))
                except json.JSONDecodeError: raise RuntimeError('Incomplete journal; preserve and repair before resume')
        finished={r['sampleKey'] for r in records}
        for row in records:
            raw=OUT/(row['sampleKey'].replace('/','_')+'.json')
            if raw.exists():
                result=json.loads(raw.read_text(encoding='utf8')).get('result') or {}
                row['fallback'],row['realLlm']=inference_classification(result)
                tele_file=OUT/(row['sampleKey'].replace('/','_')+'-telemetry.json')
                tele=json.loads(tele_file.read_text(encoding='utf8')) if tele_file.exists() else {}
                row['providerSamples']=measured_providers(result,tele)
                row['tokensPerSecond']=mean([p.get('tokensPerSecond') for p in row['providerSamples']])
                row['metricsComplete']=complete_metrics(row)
        active_file=OUT/'active-request.json'
        active=json.loads(active_file.read_text(encoding='utf8')) if active_file.exists() else None
        if active and active['sampleKey'] in finished:active_file.unlink();active=None
        rng=random.Random(manifest['seed']); round_id=0
        atomic(OUT/'summary.json',summarize(manifest,records,'running'))
        stop=False;telemetry_cursor=0;telemetry_instance=None
        while time.time()<manifest['deadlineAt'] and not stop:
            order=cases[:];rng.shuffle(order)
            for case in order:
                modes=MODES[:];rng.shuffle(modes)
                for mode in modes:
                    key=f'{round_id}/{case["id"]}/{mode}'
                    if key in finished:continue
                    evidence=stopping_evidence(cases,records,args.min_valid)
                    manifest['stopping']=evidence
                    if evidence['ready']:stop=True;break
                    cell=[r for r in records if r['caseId']==case['id'] and r['mode']==mode]
                    valid=[r for r in cell if complete_metrics(r)]
                    if len(cell)>=args.max_attempts or (len(valid)>=args.min_valid and statistics.stdev([r['latencyMs'] for r in valid])/statistics.mean([r['latencyMs'] for r in valid])<=.25):continue
                    if time.time()>=manifest['deadlineAt'] or (OUT/'STOP').exists():stop=True;break
                    started=time.time();rid=None
                    row=dict(sampleKey=key,round=round_id,caseId=case['id'],mode=mode,startedAt=now(),expected=case['expected_agents'])
                    try:
                        idem='local24h-'+hashlib.sha256((manifest['startedAt']+key).encode()).hexdigest()
                        if active and active['sampleKey']!=key:raise RuntimeError('Active receipt order mismatch; refuse overlapping request')
                        receipt=active or dict(sampleKey=key,idempotencyKey=idem,createdAt=now(),requestId=None)
                        atomic(active_file,receipt)
                        accepted=request(args.base,'/api/runs',dict(query=case['query'],mode=mode,commercialJudge=False),idempotency=idem)
                        rid=accepted['requestId'];row['requestId']=rid
                        if receipt.get('requestId') and receipt['requestId']!=rid:raise RuntimeError('Owned active request was lost; refuse overlapping request')
                        receipt['requestId']=rid;atomic(active_file,receipt)
                        while time.time()-started<600:
                            snapshot=request(args.base,'/api/runs/'+rid)
                            if snapshot['status'] in ['completed','partial_failed','failed','cancelled'] and snapshot.get('executionSettled'):break
                            time.sleep(1)
                        else:
                            request(args.base,'/api/runs/'+rid,method='DELETE');raise TimeoutError('600s client deadline; owned request cancelled')
                        result=snapshot.get('result') or {};metrics=result.get('metrics') or {}
                        tele_run=None
                        for _ in range(100):
                            packet=request(args.base,f'/api/telemetry?after={telemetry_cursor}'+('' if not telemetry_instance else '&instance='+telemetry_instance))
                            telemetry_cursor=packet['nextCursor'];telemetry_instance=packet['instanceId']
                            tele_run=next((r for r in packet.get('runs',[]) if r['runId']==rid),tele_run)
                            if not packet.get('hasMore'):break
                        atomic(OUT/(key.replace('/','_')+'-telemetry.json'),tele_run or {})
                        selected=[a for a in result.get('agents',[]) if a.get('selected')]
                        actual={a['id'] for a in selected};expected=set(case['expected_agents'])
                        f1=2*len(actual&expected)/(len(actual)+len(expected)) if actual or expected else 1
                        fallback,real_llm=inference_classification(result)
                        row.update(status=snapshot['status'],latencyMs=metrics.get('latencyMs'),wallMs=round((time.time()-started)*1000),
                            selected=sorted(actual),selectedCount=len(actual),agentF1=f1*100,calls=metrics.get('calls'),
                            completionTokens=(metrics.get('tokenBreakdown') or {}).get('completionTokens'),
                            ttftMs=metrics.get('ttftMs'),tpotMs=metrics.get('tpotMs'),fallback=fallback,
                            providerSamples=measured_providers(result,tele_run),
                            realLlm=real_llm,routerDecision=result.get('routerDecision'),
                            qualityScore=metrics.get('qualityScore'),citationValidity=metrics.get('citationValidity'))
                        row['tokensPerSecond']=mean([p.get('tokensPerSecond') for p in row['providerSamples']])
                        row['metricsComplete']=complete_metrics(row)
                        if 'facts' in case:row.update(facts.evaluate(case,result))
                        atomic(OUT/(key.replace('/','_')+'.json'),snapshot)
                    except Exception as e:
                        row.update(status='measurement-error',error=type(e).__name__+': '+str(e),wallMs=round((time.time()-started)*1000))
                        if rid:
                            try:
                                request(args.base,'/api/runs/'+rid,method='DELETE')
                                for _ in range(30):
                                    state=request(args.base,'/api/runs/'+rid)
                                    if state.get('executionSettled'): break
                                    time.sleep(1)
                                else: raise RuntimeError('Cancelled execution has not settled')
                            except Exception:
                                row['unsafeToContinue']=True;stop=True
                        else: raise RuntimeError('Request acceptance uncertain; retained idempotent receipt for recovery') from e
                    row['finishedAt']=now()
                    with journal.open('a',encoding='utf8') as f:
                        f.write(json.dumps(row,ensure_ascii=False)+'\n');f.flush();os.fsync(f.fileno())
                    records.append(row);finished.add(key)
                    if not row.get('unsafeToContinue'):active_file.unlink(missing_ok=True);active=None
                    atomic(OUT/'summary.json',summarize(manifest,records,'running'))
                    print(json.dumps({k:row.get(k) for k in ['sampleKey','requestId','status','latencyMs','fallback']},ensure_ascii=False),flush=True)
                    if args.max_samples and len(records)>=args.max_samples:stop=True
                    if stop:break
                if stop:break
            round_id+=1
            if round_id>=args.max_attempts:break
        manifest['stopping']=stopping_evidence(cases,records,args.min_valid);atomic(file,manifest)
        status='completed' if manifest['stopping']['ready'] else 'incomplete'
        atomic(OUT/'summary.json',summarize(manifest,records,status))
        if status=='completed' and not args.no_video:
            result=subprocess.run([sys.executable,str(ROOT/'scripts/finalize-local-24h.py')],cwd=ROOT)
            atomic(OUT/'finalization.json',dict(returncode=result.returncode,finishedAt=now()))
    finally:
        lock.unlink(missing_ok=True)
        if os.name=='nt':ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--hours',type=float,default=24);p.add_argument('--min-valid',type=int,default=3);p.add_argument('--max-attempts',type=int,default=6);p.add_argument('--base',default='http://127.0.0.1:3100');p.add_argument('--max-samples',type=int);p.add_argument('--no-video',action='store_true');run(p.parse_args())
