import json
import os
from pathlib import Path
import signal
import subprocess
import time
root=(Path.home()/'axnetcc-showcase-20261008').resolve();release=root/'release';shared=root/'shared'
file=shared/'monitor-process.json';record=json.loads(file.read_text());proc=Path('/proc')/str(record['pid'])
assert Path(record['ownedRoot']).resolve()==root and (proc/'cwd').resolve()==release
assert [v.decode() for v in (proc/'cmdline').read_bytes().split(b'\0')[:-1]]==record['args']
raw=(proc/'environ').read_bytes().split(b'\0');env={part.split(b'=',1)[0].decode():part.split(b'=',1)[1].decode() for part in raw if b'=' in part}
os.kill(record['pid'],signal.SIGTERM)
for _ in range(100):
    if not proc.exists() or (proc/'stat').read_text().split()[2]=='Z':break
    time.sleep(.1)
else:raise RuntimeError('Dedicated monitor did not stop')
with (root/'logs/monitor.log').open('ab') as output:
    process=subprocess.Popen(record['args'],cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
record.update({'pid':process.pid,'startedAt':int(time.time()*1000)});file.write_text(json.dumps(record))
print(json.dumps({'monitorRestarted':True,'pid':process.pid,'port':36200,'coreExecutionUntouched':True}))
