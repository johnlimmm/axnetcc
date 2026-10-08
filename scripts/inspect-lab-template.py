from pathlib import Path
import zipfile, collections, json, sys
sys.stdout.reconfigure(encoding='utf8')
from xml.etree import ElementTree as ET
root=Path(__file__).resolve().parents[1]
out=root/'outputs/lab-template'; out.mkdir(parents=True,exist_ok=True)
src=Path('C:/Users/Daesik/Dropbox/26-4Q 2학기/세미나/20261007_Daesik Kim.pptx')
with zipfile.ZipFile(src) as z:
    colors=collections.Counter(); fonts=collections.Counter()
    for name in z.namelist():
        if name.startswith('ppt/media/') or name.startswith('docProps/thumbnail'):
            (out/Path(name).name).write_bytes(z.read(name))
        if name.endswith('.xml') and name.startswith('ppt/'):
            tree=ET.fromstring(z.read(name))
            for e in tree.iter():
                if e.tag.endswith('}srgbClr'): colors[e.get('val')]+=1
                if e.get('typeface'): fonts[e.get('typeface')]+=1
            if name.startswith('ppt/slides/slide'):
                texts=[e.text for e in tree.iter() if e.tag.endswith('}t') and e.text]
                print(name, ' | '.join(texts)[:160])
    print(json.dumps({'colors':colors.most_common(20),'fonts':fonts.most_common(12),'assets':[p.name for p in out.iterdir()]},ensure_ascii=False))
