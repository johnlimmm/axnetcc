"""Restore only the dedicated showcase gateway."""
import json
from pathlib import Path
import urllib.request
root=Path.home()/'axnetcc-showcase-20261008'
config=json.loads((root/'shared/gateway.json').read_text())
request=urllib.request.Request('http://127.0.0.1:20444/fault',
    data=json.dumps({'scenario':'healthy','agentId':'all','ttlMs':1000}).encode(),
    headers={'content-type':'application/json','authorization':'Bearer '+config['controlToken']})
with urllib.request.urlopen(request,timeout=10) as response: result=json.load(response)
print(json.dumps({'faultRestored':result.get('scenario')=='healthy'}))
