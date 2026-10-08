"""Prove and restart one dedicated inference process group after a censored sample."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

root=(Path.home()/'axnetcc-showcase-20261008').resolve();shared=root/'shared';release=root/'release'
file=shared/'model-process.json';record=json.loads(file.read_text());pid=record['pid'];proc=Path('/proc')/str(pid)
assert Path(record['ownedRoot']).resolve()==root and (proc/'cwd').resolve()==release
assert [v.decode() for v in (proc/'cmdline').read_bytes().split(b'\0')[:-1]]==record['args']
assert os.getpgid(pid)==pid
raw=(proc/'environ').read_bytes().split(b'\0')
previous={part.split(b'=',1)[0].decode():part.split(b'=',1)[1].decode() for part in raw if b'=' in part}
env=os.environ.copy()
for key in ['OLLAMA_MODELS','OLLAMA_HOST','OLLAMA_NUM_PARALLEL','OLLAMA_MAX_LOADED_MODELS','OLLAMA_MAX_QUEUE','HOME']:
    if key in previous:env[key]=previous[key]
assert env['OLLAMA_HOST']=='127.0.0.1:14434'
os.killpg(pid,signal.SIGTERM)
def members():
    found=[]
    for p in Path('/proc').glob('[0-9]*'):
        try:
            fields=(p/'stat').read_text().rsplit(')',1)[1].split()
            if int(fields[2])==pid and fields[0]!='Z':found.append(int(p.name))
        except (OSError,ValueError,IndexError):pass
    return found
for _ in range(150):
    if not members():break
    time.sleep(.1)
else:raise RuntimeError('Dedicated model group did not terminate; no continued admission')
with (root/'logs/showcase-ollama.log').open('ab') as output:
    process=subprocess.Popen(record['args'],cwd=release,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
record.update({'pid':process.pid,'startedAt':int(time.time()*1000)});file.write_text(json.dumps(record))
for _ in range(100):
    try:
        with urllib.request.urlopen('http://127.0.0.1:14434/api/tags',timeout=2) as response:json.load(response)
        break
    except OSError:time.sleep(.2)
else:raise RuntimeError('Restarted dedicated model unavailable')
print(json.dumps({'previousPid':pid,'newPid':process.pid,'oldGroupStopped':True,'modelPort':14434}))
