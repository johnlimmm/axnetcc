import importlib.util,json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('f',root/'scripts/finalize-local-24h.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
b=f.Browser()
print(json.dumps(b.js('({url:location.href,details:[...document.querySelectorAll(".scoreDetails")].map(e=>({open:e.open,rect:e.getBoundingClientRect().toJSON()})),size:{width:innerWidth,height:innerHeight},scrollY})'),ensure_ascii=True))
b.shot(f.VIDEO/'click-debug.png')
