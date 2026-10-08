import json
from pathlib import Path
root=Path.home()/'axnetcc-showcase-20261008'
report=json.loads((root/'shared/campaign.json').read_text())
print(json.dumps({'state':report['state'],'samples':len(report['samples']),'planned':report['manifest']['plannedCount'],'last':[{k:s.get(k) for k in ['method','scenario','status','elapsedMs','realInference','ttftMs','tpotMs','tokensPerSecond']} for s in report['samples'][-4:]]}))
for method in ['centralized','remoterag']:
    sample=next((s for s in report['samples'] if s['method']==method),None)
    if sample:
        snapshot=json.loads((root/'shared'/(sample['requestId']+'.json')).read_text())
        result=snapshot.get('result',{})
        print(json.dumps({'method':method,'metrics':result.get('metrics'),
          'agentInference':[{k:a.get(k) for k in ['id','selected','inference']} for a in result.get('agents',[]) if a.get('selected')]}))
