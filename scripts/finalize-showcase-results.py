"""Recalculate explicit evidence-only classification from raw immutable observations."""
import hashlib
import json
from pathlib import Path
root=Path.home()/'axnetcc-showcase-20261008';shared=root/'shared'
path=shared/'campaign.json'
raw=path.read_bytes();report=json.loads(raw)
assert report['state']!='running','Never rewrite a live campaign'
original=shared/'campaign-observed.json'
if original.exists():raise RuntimeError('Already finalized; do not overwrite original')
original.write_bytes(raw)
for sample in report['samples']:
    d=sample.get('distributed',{})
    participants=[a for a in d.get('attempts',[]) if a.get('adopted') and a.get('usageStatus')!='not-started']+d.get('calls',[])
    sample['originalRealInferenceClassification']=sample.get('realInference')
    sample['realInference']=bool(participants) and all(a.get('backend')=='ollama' and a.get('status')=='succeeded' for a in participants)
report['postprocessing']={'version':'evidence-only-classification/v1','originalSha256':hashlib.sha256(raw).hexdigest(),
  'rule':'Exclude explicitly not-started evidence-only Agent attempts when assessing provider inference; retain all attempts for transport/byte accounting. No timing or status changed.'}
temporary=shared/'campaign.json.tmp';temporary.write_text(json.dumps(report,ensure_ascii=False,indent=2));temporary.replace(path)
print(json.dumps({'state':report['state'],'samples':len(report['samples']),'completedRealInference':sum(s['status']=='completed' and s['realInference'] for s in report['samples']),
                  'originalPreserved':True,'faultRestored':report.get('faultRestored')}))
