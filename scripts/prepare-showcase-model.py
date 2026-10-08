"""Create dedicated inference process using existing model files; restart only showcase app PIDs."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request

old=Path.home()/'axnetcc-demo-20260923'
root=(Path.home()/'axnetcc-showcase-20261008').resolve();release=root/'release';shared=root/'shared'
records=[]
for file in shared.glob('*-process.json'):
    name=file.name[:-13]
    if name not in ['service','operator'] and not name.startswith('edge-'):continue
    record=json.loads(file.read_text());proc=Path('/proc')/str(record['pid'])
    assert Path(record['ownedRoot']).resolve()==root and (proc/'cwd').resolve()==release
    actual=[v.decode() for v in (proc/'cmdline').read_bytes().split(b'\0')[:-1]]
    assert actual==record['args'],'Process identity changed'
    records.append((name,file,record))
ollama=old/'runtime/ollama-0.33.3/bin/ollama'
assert ollama.exists()
oldModel=json.loads((old/'shared/model-process.json').read_text())
environmentFile=Path('/proc')/str(oldModel['pid'])/'environ'
environment=environmentFile.read_bytes().split(b'\0') if environmentFile.exists() else []
original={v.split(b'=',1)[0].decode():v.split(b'=',1)[1].decode() for v in environment if b'=' in v}
models=Path(original.get('OLLAMA_MODELS',str(old/'models')))
assert models.is_dir()
with socket.socket() as sock:sock.bind(('127.0.0.1',14434))
modelHome=shared/'model-home';modelHome.mkdir(exist_ok=True)
env=os.environ.copy();env.update({'OLLAMA_MODELS':str(models),'OLLAMA_HOST':'127.0.0.1:14434','OLLAMA_NUM_PARALLEL':'1','OLLAMA_MAX_LOADED_MODELS':'1','OLLAMA_MAX_QUEUE':'16','HOME':str(modelHome)})
with (root/'logs/showcase-ollama.log').open('ab') as output:
    model=subprocess.Popen([str(ollama),'serve'],cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
modelRecord={'pid':model.pid,'ownedRoot':str(root),'cwd':str(release),'args':[str(ollama),'serve'],'startedAt':int(time.time()*1000)}
(shared/'model-process.json').write_text(json.dumps(modelRecord))
tags=None
for _ in range(50):
    try:
        with urllib.request.urlopen('http://127.0.0.1:14434/api/tags',timeout=2) as response:tags=json.load(response)
        break
    except OSError:time.sleep(.2)
assert tags is not None
available={item['name'] for item in tags['models']}
for name,file,record in records:
    configFile=shared/f'{name}.json'
    config=json.loads(configFile.read_text()) if configFile.exists() else json.loads((old/'shared/config'/f'{name}.json').read_text())
    assert config['LOCAL_LLM_MODEL'] in available,'Configured model absent from existing store'
    config.update({'LOCAL_LLM_BASE_URL':'http://127.0.0.1:14434','EXECUTION_LOG_ENABLED':'true','DEMO_DEPLOYMENT_ID':'showcase-20261008'})
    if name in ['service','operator']:
        config.update({'EDGE_AGENT_TIMEOUT_MS':'110000','EDGE_AGENT_BUDGET_MS':'115000','DEMO_RUN_TIMEOUT_MS':'120000'})
    configFile.write_text(json.dumps(config));configFile.chmod(0o600)
    os.kill(record['pid'],signal.SIGTERM)
    for _ in range(100):
        proc=Path('/proc')/str(record['pid'])
        if not proc.exists() or (proc/'stat').read_text().split()[2]=='Z':break
        time.sleep(.1)
    else:raise RuntimeError('Owned app did not stop; no force kill')
    env=os.environ.copy();env.update({str(k):str(v) for k,v in config.items()})
    with (root/'logs'/f'{name}.log').open('ab') as output:
        process=subprocess.Popen(record['args'],cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
    record.update({'pid':process.pid,'startedAt':int(time.time()*1000),'dedicatedInference':True});file.write_text(json.dumps(record))
if (shared/'manifest.json').exists():
    diagnostic=shared/'diagnostic-shared-inference';diagnostic.mkdir(exist_ok=False)
    for name in ['campaign.json','manifest.json','samples.jsonl']:
        p=shared/name
        if p.exists():p.rename(diagnostic/name)
print(json.dumps({'dedicatedModelPid':model.pid,'models':sorted(available),'appCount':len(records),'modelPort':14434,'sharedInferenceUntouched':True}))
