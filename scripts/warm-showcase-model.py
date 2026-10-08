import json
from pathlib import Path
import time
import urllib.request
root=Path.home()/'axnetcc-showcase-20261008'
configFile=root/'shared/edge-tech.json'
if not configFile.exists():configFile=root/'shared/operator.json'
config=json.loads(configFile.read_text())
body={'model':config['LOCAL_LLM_MODEL'],'prompt':'확인','stream':False,'think':False,'keep_alive':'30m',
      'options':{'num_predict':1,'num_ctx':int(config.get('DEMO_LLM_NUM_CTX',16384)),'num_thread':int(config.get('DEMO_LLM_NUM_THREAD',8))}}
request=urllib.request.Request('http://127.0.0.1:14434/api/generate',data=json.dumps(body).encode(),headers={'content-type':'application/json'},method='POST')
start=time.monotonic()
with urllib.request.urlopen(request,timeout=120) as response:value=json.load(response)
assert value.get('done') is True
print(json.dumps({'warmupFinalObserved':True,'model':config['LOCAL_LLM_MODEL'],'elapsedMs':round((time.monotonic()-start)*1000),
                 'loadDurationNs':value.get('load_duration'),'promptTokens':value.get('prompt_eval_count'),'completionTokens':value.get('eval_count')}))
