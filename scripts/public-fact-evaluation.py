"""Frozen source-backed fact checklist; not a full semantic correctness judge."""
import hashlib,json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def load_cases():
    file=ROOT/'data/evaluation/public-fact-qa.json'
    rubric=json.loads(file.read_text(encoding='utf8'))
    docs={d['id']:d for d in json.loads((ROOT/'data/rag-corpus.json').read_text(encoding='utf8'))['documents']}
    norm=lambda s:''.join(c for c in s.lower() if c.isalnum())
    for case in rubric['cases']:
        for fact in case['facts']:
            doc=docs[fact['sourceId']]
            assert norm(fact['quote']) in norm(doc['text']), (case['id'],fact['quote'])
            fact['sourceSha256']=hashlib.sha256(doc['text'].encode()).hexdigest()
            re.compile(fact['pattern']);re.compile(fact['negative'])
    return rubric['cases'],hashlib.sha256(file.read_bytes()).hexdigest()

def evaluate(case,result):
    report=result.get('report') or {}
    # Do not score echoed question, references, Agent evidence, or routing explanations.
    text='\n'.join([result.get('conclusion') or '',report.get('executiveSummary') or '']+
        [section.get('content','') for section in report.get('sections',[])])
    text=text.replace(case['query'],'')
    text=re.sub(r'(?m)^.*(?:요청\s*Q\d+|미검증 사용자 요청 인용|참고문헌|출처 목록|근거 자료 목록).*$', '', text)
    checks=[]
    for fact in case['facts']:
        positive=bool(re.search(fact['pattern'],text,re.I|re.S))
        negative=bool(re.search(fact['negative'],text,re.I|re.S))
        checks.append(dict(sourceId=fact['sourceId'],reference=fact['quote'],matched=positive,contradictionDetected=negative,passRule=positive and not negative))
    return dict(factCoverage=100*sum(c['passRule'] for c in checks)/len(checks),
        allFactsPass=all(c['passRule'] for c in checks),checks=checks,
        semantics='source-backed rule-based fact checklist; unrecognized paraphrases and other false claims need separate semantic review')

if __name__=='__main__':
    cases,digest=load_cases();print(json.dumps(dict(cases=len(cases),facts=sum(len(c['facts']) for c in cases),rubricHash=digest,sourceQuotesVerified=True)))
