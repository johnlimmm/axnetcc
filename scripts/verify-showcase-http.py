"""Read-only live endpoint evidence; never submit another measured request."""
import json
from collections import Counter
from pathlib import Path
import urllib.request

root=Path(__file__).resolve().parents[1]/'outputs/showcase-20261008'
results={}
urls=['http://127.0.0.1:3100/','http://127.0.0.1:3200/distributed',
      'http://127.0.0.1:36100/','http://127.0.0.1:36200/distributed']
urls += ['http://127.0.0.1:36200/api/'+name for name in ['campaign','network','execution-logs']]
for url in urls:
    with urllib.request.urlopen(url,timeout=20) as response:
        raw=response.read();results[url]={'status':response.status,'bytes':len(raw)}
    if '/api/' in url:
        value=json.loads(raw)
        (root/(url.rsplit('/',1)[1]+'-api.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf8')
        results[url].update(state=value.get('manifest',{}).get('state'),hosts=dict(Counter(e.get('host') for e in value.get('events',[]))))
(root/'http-verification.json').write_text(json.dumps(results,indent=2),encoding='utf8')
print(json.dumps(results))
