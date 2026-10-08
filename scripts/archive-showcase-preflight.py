import json
from pathlib import Path
import urllib.request
root=(Path.home()/'axnetcc-showcase-20261008').resolve();shared=root/'shared'
with urllib.request.urlopen('http://127.0.0.1:36101/api/health',timeout=5) as response:health=json.load(response)
assert health['scheduler']['activeCount']==0 and health['scheduler']['queueDepth']==0
target=shared/'diagnostic-dedicated-coldstart';target.mkdir(exist_ok=False)
for name in ['campaign.json','manifest.json','samples.jsonl']:
    source=shared/name
    assert source.resolve().is_relative_to(root) and target.resolve().is_relative_to(root)
    if source.exists():source.rename(target/name)
print(json.dumps({'diagnosticPreserved':True,'schedulerIdle':True}))
