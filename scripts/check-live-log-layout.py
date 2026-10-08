import importlib.util,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('f',root/'scripts/finalize-local-24h.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
spec=importlib.util.spec_from_file_location('r',root/'scripts/record-showcase-video.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
b=f.Browser();b.navigate('http://127.0.0.1:36300/')
assert b.js('!!document.querySelector("#work-request")')
f.ctypes.windll.user32.ShowWindow(b.hwnd,6);r.panels()
subprocess.run([f.imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-f','gdigrab','-offset_x','0','-offset_y','0','-video_size','1920x1080','-i','desktop','-frames:v','1',str(f.VIDEO/'four-terminals-layout.png')],check=True)
print(json.dumps(dict(frontendProxy=True,terminals=[name for handle,name in r.windows() if any(title in name for title in r.TITLES)])))
