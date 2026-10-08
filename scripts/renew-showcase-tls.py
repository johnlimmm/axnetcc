"""Renew TLS and restart only proven idle showcase processes, preserving the failed pilot."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

root=(Path.home()/'axnetcc-showcase-20261008').resolve()
release=root/'release'
shared=root/'shared'
with urllib.request.urlopen('http://127.0.0.1:36101/api/health',timeout=5) as response:health=json.load(response)
assert health['scheduler']['activeCount']==0 and health['scheduler']['queueDepth']==0
records=[]
for name in ['gateway','service','operator']:
    file=shared/f'{name}-process.json';record=json.loads(file.read_text());proc=Path('/proc')/str(record['pid'])
    assert Path(record['ownedRoot']).resolve()==root and (proc/'cwd').resolve()==release
    actual=(proc/'cmdline').read_bytes().split(b'\0')[:-1]
    assert [v.decode() for v in actual]==record['args'],'Process identity changed'
    records.append((name,file,record))
cert=shared/'showcase-tls.crt';key=shared/'showcase-tls.key'
if cert.exists() or key.exists():raise RuntimeError('Showcase certificate exists; inspect before replacing')
subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','30','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],check=True,capture_output=True)
key.chmod(0o600);cert.chmod(0o600)
gateway=json.loads((shared/'gateway.json').read_text());gateway['tls']={'certFile':str(cert),'keyFile':str(key)}
(shared/'gateway.json').write_text(json.dumps(gateway))
for name in ['service','operator']:
    p=shared/f'{name}.json';config=json.loads(p.read_text());config['NODE_EXTRA_CA_CERTS']=str(cert);p.write_text(json.dumps(config))
for name,file,record in records:
    os.kill(record['pid'],signal.SIGTERM)
    for _ in range(100):
        proc=Path('/proc')/str(record['pid'])
        if not proc.exists() or (proc/'stat').read_text().split()[2]=='Z':break
        time.sleep(.1)
    else:raise RuntimeError('Owned process did not stop; no force kill')
    file.rename(shared/f'{name}-process-before-tls.json')
diagnostic=shared/'diagnostic-expired-tls';diagnostic.mkdir(exist_ok=False)
for name in ['campaign.json','manifest.json','samples.jsonl']:
    p=shared/name
    if p.exists():p.rename(diagnostic/name)
for name,file,record in records:
    env=os.environ.copy()
    if name!='gateway':env.update({str(k):str(v) for k,v in json.loads((shared/f'{name}.json').read_text()).items()})
    with (root/'logs'/f'{name}.log').open('ab') as output:
        process=subprocess.Popen(record['args'],cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
    record.update({'pid':process.pid,'startedAt':int(time.time()*1000),'tlsRenewed':True})
    file.write_text(json.dumps(record));file.chmod(0o600)
print(json.dumps({'isolatedTlsRenewed':True,'failedPilotPreserved':True}))
