"""Decode, inspect stream constraints, extract review frames, then copy the exact capture."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'outputs/video-review-tools'))
import imageio_ffmpeg
out=root/'outputs/video-production'
source=out/'silent-demo-capture.mp4'
receipt=json.loads((out/'recording-receipt.json').read_text(encoding='utf8'))
reader=imageio_ffmpeg.read_frames(str(source));metadata=next(reader);reader.close()
assert metadata['size']==(1920,1080),metadata
assert 20<metadata['duration']<300,metadata
ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
info=subprocess.run([ffmpeg,'-hide_banner','-i',str(source)],capture_output=True,text=True).stderr
assert 'Audio:' not in info and 'Subtitle:' not in info,info
decoded=subprocess.run([ffmpeg,'-v','error','-i',str(source),'-map','0:v:0','-f','null','NUL'],capture_output=True,text=True)
assert decoded.returncode==0 and not decoded.stderr.strip(),decoded.stderr
frames=[]
for i,at in enumerate([round((metadata['duration']-2)*i/8,2) for i in range(9)]+[10,round(metadata['duration']-15,2)]):
    target=out/f'review-{i:02d}.png'
    subprocess.run([ffmpeg,'-v','error','-y','-ss',str(at),'-i',str(source),'-frames:v','1',str(target)],check=True)
    frames.append({'atSeconds':at,'path':str(target)})
verification={'durationSeconds':metadata['duration'],'size':metadata['size'],'fps':metadata['fps'],
    'audioStreams':0,'subtitleStreams':0,'fullDecodePassed':True,'frames':frames,'bytes':source.stat().st_size,
    'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'visualReviewPending':True}
(out/'video-verification.json').write_text(json.dumps(verification,indent=2),encoding='utf8')
print(json.dumps(verification),flush=True)
