import sys,json,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import importlib.util
spec=importlib.util.spec_from_file_location('recorder',Path(__file__).with_name('record-showcase-video.py'))
rec=importlib.util.module_from_spec(spec);spec.loader.exec_module(rec)
b=rec.Browser();b.navigate('http://127.0.0.1:3200/evaluation');time.sleep(3)
print(json.dumps(b.js("({title:document.querySelector('h1').textContent,background:getComputedStyle(document.body).backgroundColor,figures:document.querySelectorAll('.paperFigure').length,nav:[...document.querySelectorAll('nav a')].map(a=>a.textContent),errors:document.querySelector('#notice').hidden?null:document.querySelector('#notice').textContent})"),ensure_ascii=True))
b.shot('lab-evaluation-review')
b.js("document.querySelector('#evaluation-source').value='longitudinal';document.querySelector('#evaluation-source').dispatchEvent(new Event('change',{bubbles:true}))")
time.sleep(1);b.shot('lab-24h-review')
