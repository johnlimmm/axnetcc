import importlib.util,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('f',root/'scripts/finalize-local-24h.py');f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
b=f.Browser()
for url in ['http://127.0.0.1:3200/?window=24h','http://127.0.0.1:3200/evaluation']:
 b.navigate(url)
 if 'evaluation' in url:
  for source in ['routing','longitudinal','reports','distributed']:
   b.js('(()=>{const e=document.querySelector("#evaluation-source");e.value='+json.dumps(source)+';e.dispatchEvent(new Event("change",{bubbles:true}));})()')
   print(json.dumps(dict(source=source,layout=b.js('({height:document.documentElement.scrollHeight,viewport:innerHeight,headings:[...document.querySelectorAll("#content h2")].map(e=>e.textContent)})')),ensure_ascii=False),flush=True)
 else:print(json.dumps(dict(source='overview',height=b.js('document.documentElement.scrollHeight'))),flush=True)
