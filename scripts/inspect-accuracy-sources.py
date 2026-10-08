import json,sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf8')
root=Path(__file__).resolve().parents[1]
data=json.loads((root/'data/rag-corpus.json').read_text(encoding='utf8'))
print('keys',list(data))
chunks=data.get('chunks') or data.get('documents') or []
for word in ['파싱','청킹','임베딩','검색 API','개인정보 최소','가명정보','접근통제','영향평가']:
    hits=[c for c in chunks if word in c.get('text','') and c.get('agent') in ['tech','data','security','legal']]
    print('\nTOPIC',word)
    for c in hits[:2]:
        pos=c['text'].find(word)
        print(c['id'],c.get('classification'),c['text'][max(0,pos-100):pos+400])
