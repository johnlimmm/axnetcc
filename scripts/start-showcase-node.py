"""Executed over verified SSH on an isolated showcase root. No shared service mutation."""
import json
import os
from pathlib import Path
import socket
import subprocess
import time

old = Path.home()/'axnetcc-demo-20260923'
root = Path.home()/'axnetcc-showcase-20261008'
release = root/'release'
node = old/'runtime/node-v24.20.0-linux-x64/bin/node'
if not node.exists():
    candidates = list((old/'runtime').glob('node*/bin/node'))
    if len(candidates) != 1:
        raise RuntimeError('Cannot resolve existing runtime')
    node = candidates[0]
for folder in ['shared','logs']:
    (root/folder).mkdir(parents=True,exist_ok=True)
dependencies=release/'node_modules'
if not dependencies.exists():
    dependencies.symlink_to(old/'release/node_modules',target_is_directory=True)

def available(port):
    with socket.socket() as sock:
        try: sock.bind(('127.0.0.1',port))
        except OSError: return False
    return True

def start(name, argv, env, port):
    record=root/'shared'/f'{name}-process.json'
    if record.exists():
        value=json.loads(record.read_text())
        pid=value['pid']
        proc=Path('/proc')/str(pid)
        if proc.exists() and (proc/'cwd').resolve()==release.resolve():
            return {'name':name,'pid':pid,'port':port,'reused':True}
        raise RuntimeError('Existing ownership record needs inspection')
    if not available(port):
        raise RuntimeError('Showcase port already occupied')
    merged=os.environ.copy();merged.update({str(k):str(v) for k,v in env.items()})
    with (root/'logs'/f'{name}.log').open('ab') as output:
        process=subprocess.Popen(argv,cwd=release,env=merged,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
    value={'pid':process.pid,'ownedRoot':str(root),'cwd':str(release),'args':argv,'startedAt':int(time.time()*1000)}
    record.write_text(json.dumps(value));record.chmod(0o600)
    return {'name':name,'pid':process.pid,'port':port,'reused':False}

started=[]
configs=old/'shared/config'
edges=sorted(configs.glob('edge-*.json'))
if edges:
    # Port associations come from existing process records, not alphabetical Agent order.
    for config in edges:
        agent=config.stem[5:]
        source=old/'shared'/f'edge-{agent}-process.json'
        record=json.loads(source.read_text())
        argv=record.get('args',record.get('argv',[]))
        if '--port' not in argv:
            raise RuntimeError('Missing authoritative Edge port')
        port=int(argv[argv.index('--port')+1])+1000
        env=json.loads(config.read_text());env['EXECUTION_LOG_ENABLED']='true';env['DEMO_DEPLOYMENT_ID']='showcase-20261008'
        started.append(start(f'edge-{agent}',[str(node),str(release/'node_modules/vinext/dist/cli.js'),'start','--hostname','127.0.0.1','--port',str(port)],env,port))
else:
    gatewayFile=root/'shared/gateway.json'
    gateway=json.loads(gatewayFile.read_text()) if gatewayFile.exists() else json.loads((configs/'gateway.json').read_text())
    if gateway.get('port')!=20443:
        gateway.update({'port':20443,'controlPort':20444})
        for route in gateway['routes']:
            route['port']+=1000
    gatewayFile.write_text(json.dumps(gateway));gatewayFile.chmod(0o600)
    started.append(start('gateway',[str(node),str(release/'scripts/demo-gateway.mjs'),'--config',str(gatewayFile)],{},20443))
    for name,port in [('service',36100),('operator',36101)]:
        saved=root/'shared'/f'{name}.json'
        env=json.loads(saved.read_text()) if saved.exists() else json.loads((configs/f'{name}.json').read_text())
        for key,value in list(env.items()):
            if key.endswith('_BASE_URL') and isinstance(value,str) and ':19443/' in value:
                env[key]=value.replace(':19443/',':20443/')
        env.update({'EXECUTION_LOG_ENABLED':'true','DEMO_DEPLOYMENT_ID':'showcase-20261008','MONITOR_PUBLIC_URL':'http://localhost:36200',
          'FEEDBACK_DIRECTORY':str(root/'shared/feedback')})
        (root/'shared'/f'{name}.json').write_text(json.dumps(env));(root/'shared'/f'{name}.json').chmod(0o600)
        started.append(start(name,[str(node),str(release/'node_modules/vinext/dist/cli.js'),'start','--hostname','127.0.0.1','--port',str(port)],env,port))
    monitor=json.loads((configs/'monitor.json').read_text())
    monitor.update({'MONITOR_SERVICE_URL':'http://127.0.0.1:36101','MONITOR_PORT':'36200','MONITOR_DATABASE':str(root/'shared/telemetry.sqlite'),
      'MONITOR_CAMPAIGN_REPORT':str(root/'shared/campaign.json'),'MONITOR_EXECUTION_LOGS':str(root/'shared/execution-logs.json'),
      'MONITOR_NETWORK_TARGETS':json.dumps([{'nodeId':'mnckoren-ssh','host':'210.114.95.58','port':22},{'nodeId':'ai-cloud-ssh','host':'116.89.177.90','port':31055}])})
    started.append(start('monitor',[str(node),'--experimental-strip-types',str(release/'monitor/server.mjs')],monitor,36200))
    # Reuse an already-authenticated server-to-server tunnel, adding dedicated ports only.
    control=old/'transport/hub.sock'
    check=subprocess.run(['ssh','-S',str(control),'-O','check','unused'],capture_output=True,timeout=5)
    if check.returncode:
        raise RuntimeError('Existing hub SSH tunnel unavailable')
    for index in range(8):
        port=26201+index
        if available(port):
            result=subprocess.run(['ssh','-S',str(control),'-O','forward','-L',f'127.0.0.1:{port}:127.0.0.1:{6201+index}','unused'],capture_output=True,timeout=5)
            if result.returncode:
                raise RuntimeError('Cannot add isolated hub forward')
print(json.dumps({'root':str(root),'started':started}))
