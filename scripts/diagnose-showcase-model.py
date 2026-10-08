import json
from pathlib import Path
import urllib.request
root=Path.home()/'axnetcc-showcase-20261008'
for endpoint in ['/api/ps','/api/tags']:
    try:
        with urllib.request.urlopen('http://127.0.0.1:14434'+endpoint,timeout=3) as response:value=json.load(response)
        print(json.dumps({'endpoint':endpoint,'models':[{k:item.get(k) for k in ['name','size','size_vram','expires_at']} for item in value.get('models',[])]}))
    except Exception as error:print(json.dumps({'endpoint':endpoint,'errorType':type(error).__name__}))
for name in ['showcase-ollama.log','edge-tech.log','edge-procurement.log']:
    p=root/'logs'/name
    if p.exists():print(json.dumps({'file':name,'tail':p.read_text(errors='replace').splitlines()[-16:]}))
