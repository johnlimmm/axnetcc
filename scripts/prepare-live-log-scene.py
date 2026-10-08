"""Prepare owned terminal windows and verify a fresh isolated distributed run."""
import argparse,importlib.util,json,os,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('rec',root/'scripts/record-showcase-video.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--credential-session',default=os.environ.get('DEMO_CREDENTIAL_SESSION'))
args=parser.parse_args()
if not args.credential_session:parser.error('--credential-session or DEMO_CREDENTIAL_SESSION is required')
credentials=args.credential_session
r.prepare()
try:
 r.remote_script('video-backup-fault.py',credentials)
 start=time.monotonic()
 request=r.submit('http://127.0.0.1:36100','공공 AI 민원 상담에서 RAG 파싱 기능과 개인정보 보호 조치를 공개 근거로 간단히 설명해 주세요.')
 result=r.observe('http://127.0.0.1:36100',request,100)
 assert result and result['status']=='completed'
 print(json.dumps(dict(preflightRequest=request,elapsed=time.monotonic()-start)),flush=True)
finally:r.remote_script('video-restore-fault.py',credentials)
