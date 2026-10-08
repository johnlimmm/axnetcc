"""Exercise real selection clicks and a short owned-window cursor capture."""
import importlib.util,json,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('finalizer',root/'scripts/finalize-local-24h.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
records=[json.loads(v) for v in (root/'reports/local-evaluation/measurements.jsonl').read_text(encoding='utf8').splitlines()]
record=next(r for r in reversed(records) if r['mode']=='proposed' and r['metricsComplete'])
b=f.Browser();b.navigate('http://127.0.0.1:3100/?run='+record['requestId'])
b.click('.scoreDetails summary');assert b.js('document.querySelector(".scoreDetails").open')
b.click('.candidateComparison summary');assert b.js('document.querySelector(".candidateComparison").open')
b.shot(f.VIDEO/'selection-reasons-reviewed.png')
b.navigate('http://127.0.0.1:3200/evaluation')
b.select_longitudinal()
assert b.js('document.querySelector("#evaluation-source").value')=='longitudinal'
assert b.js('document.querySelectorAll(".paperFigure").length')==8
b.shot(f.VIDEO/'local-evaluation-metrics-reviewed.png')
target=f.VIDEO/'cursor-capture-check.mp4'
command=[f.imageio_ffmpeg.get_ffmpeg_exe(),'-y','-f','gdigrab','-framerate','15','-draw_mouse','1','-offset_x','0','-offset_y','0','-video_size','1920x1080','-i','desktop','-t','2','-an','-c:v','libx264','-pix_fmt','yuv420p',str(target)]
result=subprocess.run(command,capture_output=True,timeout=20)
assert result.returncode==0,result.stderr.decode('utf8','replace')[-1000:]
reader=f.imageio_ffmpeg.read_frames(str(target));meta=next(reader);first=next(reader);reader.close()
from PIL import Image,ImageStat
assert max(ImageStat.Stat(Image.frombytes('RGB',meta['size'],first)).stddev)>8
print(json.dumps(dict(realSelectionClicks=True,expandedDetails=True,paperFigures=8,cursorCapture=True,nonblankCapture=True)))
