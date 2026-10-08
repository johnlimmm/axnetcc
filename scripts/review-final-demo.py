"""Extract final demo frames for visual review without modifying the video."""
import importlib.util,json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('finalizer',root/'scripts/finalize-local-24h.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
continuous='--continuous' in sys.argv
receipt=root/'outputs/video-production/continuous-tour-verification.json' if continuous else root/'reports/local-evaluation/video-verification.json'
verification=json.loads(receipt.read_text(encoding='utf-8-sig'))
frames=[]
times=[0,9,35,75,105,130,165,205,min(verification['durationSeconds']-3,260)] if continuous else [0,7,20,33,51,65,90,145,160]
for at in times:
    target=f.VIDEO/f'{"continuous" if continuous else "final-demo"}-review-{int(at):03d}.png'
    subprocess.run([f.imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-y','-ss',str(at),'-i',verification['path'],'-frames:v','1',str(target)],check=True)
    frames.append((at,target))
sheet=f.Image.new('RGB',(1440,900),'white')
draw=f.ImageDraw.Draw(sheet)
for index,(at,path) in enumerate(frames):
    x=index%3*480;y=index//3*300
    sheet.paste(f.Image.open(path).resize((480,270)),(x,y));draw.text((x+10,y+275),f'{at}s',fill='black')
sheet.save(f.VIDEO/('continuous-contact-sheet.png' if continuous else 'final-demo-contact-sheet.png'))
print(json.dumps(verification,ensure_ascii=False))
