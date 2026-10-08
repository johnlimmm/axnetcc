"""Only the dedicated showcase tech route; expires automatically after 90 seconds."""
import json
from pathlib import Path
import urllib.request
root=Path.home()/'axnetcc-showcase-20261008'
config=json.loads((root/'shared/gateway.json').read_text())
request=urllib.request.Request('http://127.0.0.1:20444/fault',
    data=json.dumps({'scenario':'primary-down','agentId':'tech','ttlMs':90000}).encode(),
    headers={'content-type':'application/json','authorization':'Bearer '+config['controlToken']})
with urllib.request.urlopen(request,timeout=10) as response: result=json.load(response)
print(json.dumps({'fault':'primary-down','agentId':'tech','ttlMs':90000,'accepted':result.get('scenario')=='primary-down'}))
