import json
import ssl
import urllib.request
from pathlib import Path
root=Path.home()/'axnetcc-showcase-20261008'
report=json.loads((root/'shared/campaign.json').read_text())
config=json.loads((root/'shared/operator.json').read_text())
cert=ssl._ssl._test_decode_cert(config['NODE_EXTRA_CA_CERTS'])
print(json.dumps({'certificateNotAfter':cert.get('notAfter'),'certificateNotBefore':cert.get('notBefore')}))
try:
    urllib.request.urlopen('https://127.0.0.1:20443/primary/tech/api/edge/agent',context=ssl.create_default_context(cafile=config['NODE_EXTRA_CA_CERTS']),timeout=5)
except Exception as error:
    print(json.dumps({'tlsProbeError':str(error)}))
for sample in report['samples']:
    d=sample.get('distributed',{})
    snapshotFile=root/'shared'/(sample['requestId']+'.json')
    snapshot=json.loads(snapshotFile.read_text()) if snapshotFile.exists() else {}
    print(json.dumps({'requestId':sample['requestId'],'status':sample['status'],'errorCode':snapshot.get('errorCode'),
      'attempts':[{k:a.get(k) for k in ['agentId','nodeId','replicaId','status','reasonCode','usageStatus','elapsedMs','backend']} for a in d.get('attempts',[])],
      'calls':[{k:a.get(k) for k in ['stage','status','failureCode','backend','providerFinalObserved']} for a in d.get('calls',[])]}))
for p in (root/'logs').glob('*.log'):
    lines=p.read_text(errors='replace').splitlines()
    print(json.dumps({'log':p.name,'lines':lines[-8:]}))
