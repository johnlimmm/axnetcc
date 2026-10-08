"""Read-only current demo runtime/topology inspection. Never prints tokens."""
import json
import subprocess
import importlib.util
from pathlib import Path
r = Path.home() / 'axnetcc-demo-20260923'
configs = r / 'shared/config'
result = {'node': subprocess.check_output(['hostname'], text=True).strip(), 'runtime': str((r/'runtime').resolve()),
          'dependencies': str((r/'release/node_modules').resolve()), 'ports': {}, 'topology': [], 'sockets': {}}
for name in ['service', 'operator', 'baseline', 'monitor']:
    p = configs / (name+'.json')
    if not p.exists():
        continue
    v = json.loads(p.read_text())
    result[name] = {k: value for k, value in v.items() if k in ['MONITOR_PORT','MONITOR_SERVICE_URL','LOCAL_LLM_BASE_URL','LOCAL_LLM_MODEL','DEMO_PROFILE','DEMO_CORE_NODE_ID']}
    if name == 'operator':
        for agent in ['tech','data','security','legal','policy','finance','procurement','operations']:
            prefix='EDGE_AGENT_'+agent.upper()
            result['topology'].append({'agent':agent,'primary':v.get(prefix+'_NODE_ID'),'backup':v.get(prefix+'_BACKUP_NODE_ID'),
              'primaryUrl':v.get(prefix+'_BASE_URL'),'backupUrl':v.get(prefix+'_BACKUP_BASE_URL')})
result['transportFiles']=[p.name for p in (r/'transport').glob('*')]
result['pythonParamikoAvailable']=importlib.util.find_spec('paramiko') is not None
result['edgeProcessRecords']=[]
for p in (r/'shared').glob('edge-*-process.json'):
 v=json.loads(p.read_text());result['edgeProcessRecords'].append({'name':p.name,'keys':list(v),'args':v.get('args',v.get('argv',[]))})
for name in [p.name for p in (r/'transport').glob('*.sock')]:
    p=r/'transport'/name
    if p.exists():
        c=subprocess.run(['ssh','-S',str(p),'-O','check','unused'],capture_output=True,text=True,timeout=5)
        result['sockets'][name]={'exists':True,'active':c.returncode==0}
print(json.dumps(result))
