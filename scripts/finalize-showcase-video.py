"""Copy the visually reviewed silent capture unchanged to the requested folder."""
import hashlib
import json
from pathlib import Path
import shutil

root=Path(__file__).resolve().parents[1]
out=root/'outputs/video-production'
receipt=json.loads((out/'recording-receipt.json').read_text(encoding='utf8'))
verification=json.loads((out/'video-verification.json').read_text(encoding='utf8'))
source=Path(receipt['capture']);target=Path(receipt['finalTarget'])
digest=hashlib.sha256(source.read_bytes()).hexdigest()
assert digest==verification['sha256']
assert verification['fullDecodePassed'] and verification['audioStreams']==0 and verification['subtitleStreams']==0
assert verification['durationSeconds']<300
if target.exists():
    assert hashlib.sha256(target.read_bytes()).hexdigest()==digest,'Refuse to overwrite a different final file'
else:shutil.copy2(source,target)
assert hashlib.sha256(target.read_bytes()).hexdigest()==digest
verification.update(visualReviewPending=False,visualReviewPassed=True,finalPath=str(target),copiedWithoutEditing=True)
(out/'video-verification.json').write_text(json.dumps(verification,indent=2),encoding='utf8')
analysis=target.parent/'성능평가_결과_원인분석.txt'
text=analysis.read_text(encoding='utf8')
assert '38' in text and 'CPU' in text and 'TCP' in text and '추정' in text
try:
    import runpy
    recorder=runpy.run_path(str(root/'scripts/record-showcase-video.py'))
    for handle,title in recorder['windows']():
        if title.startswith('AXNetCC LIVE ') or title in recorder['TITLES']:
            recorder['USER'].SetWindowPos(handle,-2,0,0,0,0,0x0013)
except Exception:
    pass
print(json.dumps({'video':str(target),'durationSeconds':verification['durationSeconds'],'bytes':target.stat().st_size,
    'audioStreams':0,'sha256':digest,'analysis':str(analysis),'analysisBytes':analysis.stat().st_size},ensure_ascii=False))
