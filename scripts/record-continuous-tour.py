"""One fresh continuous capture, slow page tours, no inserted footage or captions."""
import argparse,ctypes,hashlib,importlib.util,json,os,subprocess,time
from urllib.request import Request,urlopen
from pathlib import Path
root=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('f',root/'scripts/finalize-local-24h.py');f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)
video=f.VIDEO; raw=video/'continuous-tour-distributed-original.mp4'
target=f.DEST/'최종평가시연동영상_MNC Lab_전체연속녹화_08배속.mp4'
normal=f.DEST/'최종평가시연동영상_MNC Lab_전체연속녹화_1배속.mp4'
rspec=importlib.util.spec_from_file_location('rec',root/'scripts/record-showcase-video.py');rec=importlib.util.module_from_spec(rspec);rspec.loader.exec_module(rec)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--credential-session',default=os.environ.get('DEMO_CREDENTIAL_SESSION'))
args=parser.parse_args()
if not args.credential_session:parser.error('--credential-session or DEMO_CREDENTIAL_SESSION is required')
credentials=args.credential_session
def route(backend):
 with urlopen(Request('http://127.0.0.1:36300/__demo/route',data=json.dumps(dict(backend=backend)).encode(),headers={'content-type':'application/json'}),timeout=10) as response:
  assert json.load(response)['backend']==backend
route('local')
b=f.Browser();b.navigate('http://127.0.0.1:36300/')
user=ctypes.windll.user32
user.keybd_event(18,0,0,0);user.keybd_event(18,0,2,0);user.SetForegroundWindow(b.hwnd);time.sleep(1)
assert user.GetForegroundWindow()==b.hwnd
ff=f.imageio_ffmpeg.get_ffmpeg_exe()
log=(video/'continuous-tour-capture.log').open('wb')
capture=subprocess.Popen([ff,'-y','-f','gdigrab','-framerate','20','-draw_mouse','1','-offset_x','0','-offset_y','0','-video_size','1920x1080','-i','desktop','-t','239','-an','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p',str(raw)],stdin=subprocess.PIPE,stdout=log,stderr=log)
started=time.monotonic();events=[]
def mark(label):
 events.append(dict(at=round(time.monotonic()-started,3),label=label));print(json.dumps(events[-1],ensure_ascii=False),flush=True)
def check_monitor():
 if b.js('location.port')=='3200':
  assert b.js('document.querySelector("#auto").checked'),'Keep real monitoring refresh enabled'
  assert b.js('document.querySelector("#notice").hidden'),'Monitoring connection warning must be resolved'
  assert b.js('!document.querySelector("#connection").classList.contains("stale")'),'Monitor must have fresh collector data'
def scroll(y,hold=1.5):
 b.js('''(async()=>{const start=scrollY,target=Math.max(0,Math.min(%s,document.documentElement.scrollHeight-innerHeight));const duration=Math.abs(target-start)/220*1000;await new Promise(resolve=>{let begin;function step(at){begin??=at;const p=duration?Math.min(1,(at-begin)/duration):1;scrollTo({top:start+(target-start)*p,behavior:'instant'});if(p<1)requestAnimationFrame(step);else resolve();}requestAnimationFrame(step);});})()'''%json.dumps(y))
 time.sleep(hold)
 check_monitor()
def approach(selector):
 y=b.js('(()=>{const e=document.querySelector('+json.dumps(selector)+');if(!e)throw Error("Missing section");return scrollY+e.getBoundingClientRect().top-130;})()');scroll(y)
def click_visible(selector):
 rect=b.js('(()=>{const e=document.querySelector('+json.dumps(selector)+');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,sx:screenX,sy:screenY,top:outerHeight-innerHeight,h:innerHeight};})()')
 assert 0<rect['y']<rect['h'],'Click must stay in visible viewport'
 user.SetCursorPos(int(rect['sx']+rect['x']),int(rect['sy']+rect['top']+rect['y']))
 for kind in ['mousePressed','mouseReleased']:b.call('Input.dispatchMouseEvent',dict(type=kind,x=rect['x'],y=rect['y'],button='left',clickCount=1))
 time.sleep(.5)
def tour(end=None):
 last=b.js('document.documentElement.scrollHeight-innerHeight') if end is None else end
 current=b.js('scrollY')
 while current<last-1:
  current=min(last,current+650);scroll(current,1.2)
def navigate(url):
 b.navigate(url)
 if ':3200' in url:
  check_monitor()
 time.sleep(2)
def select_source(index,expected):
 scroll(0,1);b.click('#evaluation-source');b.key('Escape',27)
 b.js('(()=>{const e=document.querySelector("#evaluation-source");e.value='+json.dumps(expected)+';e.dispatchEvent(new Event("change",{bubbles:true}));})()')
 time.sleep(2)
 assert b.js('document.querySelector("#evaluation-source").value')==expected
try:
 mark('질문 직접 입력');time.sleep(3);b.click('#work-request')
 question='공공기관 민원 상담에 AI를 도입하려고 합니다. 주민의 개인정보를 외부 AI에 보내도 되는지, 도입 전에 무엇을 확인해야 하는지 알려주세요.'
 for character in question:b.call('Input.insertText',dict(text=character));time.sleep(.065)
 time.sleep(3);b.click('.primaryRequestButton');mark('실제 로컬 처리')
 for _ in range(90):
  if b.js('!!document.querySelector(".scoreDetails summary")'):break
  time.sleep(1)
 else:raise RuntimeError('Request not completed')
 mark('결과 보고서와 근거 자료');scroll(0,4)
 if b.js('!!document.querySelector(".agentReviewDetails summary")'):
  review_top=b.js('scrollY+document.querySelector(".agentReviewDetails").getBoundingClientRect().top-130')
  tour(review_top);b.js('document.querySelector(".agentReviewDetails summary").click()');time.sleep(2)
  assert b.js('document.querySelector(".agentReviewDetails").open')
 routing_top=b.js('scrollY+document.querySelector(".routingExplanation").getBoundingClientRect().top-130')
 tour(routing_top)
 mark('Agent 선택 이유');time.sleep(3)
 selection_scroll=b.js('scrollY')
 b.js('[...document.querySelectorAll(".routingExplanation details")].forEach(e=>{if(!e.open)e.querySelector("summary").click();})')
 assert b.js('[...document.querySelectorAll(".routingExplanation details")].every(e=>e.open)')
 assert b.js('scrollY')==selection_scroll,'Expanding details must not move the viewport'
 mark('선택 이유의 전체 상세 항목 펼침');time.sleep(5)
 action_top=b.js('scrollY+document.querySelector(".resultActions button").getBoundingClientRect().top-250')
 tour(action_top);b.shot(video/'continuous-selection.png')
 mark('동일 서비스 화면에서 분산 질문 입력')
 click_visible('.resultActions button');time.sleep(1)
 route('remote');b.navigate('http://127.0.0.1:36300/')
 try:
  rec.remote_script('video-backup-fault.py',credentials)
  rec.action('DEMO SCENARIO | tech primary unavailable -> ai-cloud backup | remaining Agents -> mnckoren')
  b.click('#work-request')
  remote_question='공공 AI 민원 상담에서 RAG 파싱 기능과 개인정보 보호 조치를 공개 근거로 간단히 설명해 주세요.'
  for character in remote_question:b.call('Input.insertText',dict(text=character));time.sleep(.05)
  time.sleep(2);posted_after=time.time();click_visible('.primaryRequestButton')
  remote_id=None
  for _ in range(40):
   receipts=[json.loads(line) for line in (video/'browser-request-receipts.jsonl').read_text(encoding='utf8').splitlines()]
   accepted=[receipt for receipt in receipts if receipt['backend']=='remote' and receipt['at']>=posted_after]
   if accepted:remote_id=accepted[-1]['requestId'];break
   time.sleep(.25)
  assert remote_id,'Remote request must originate from browser UI'
  rec.action('BROWSER POST -> HPC -> '+remote_id)
  time.sleep(2);mark('실제 분산 실행 · 세 노드 로그')
  # Keep the owned service behind all four topmost terminals, covering desktop gaps.
  rec.USER.SetWindowPos(b.hwnd,-2,0,0,1920,1080,0x0010)
  rec.panels();time.sleep(2)
  remote_result=rec.observe('http://127.0.0.1:36100',remote_id,65)
  assert remote_result and remote_result['status']=='completed','Distributed run must complete'
  time.sleep(4)
 finally:rec.remote_script('video-restore-fault.py',credentials)
 mark('분산 실행 완료 · '+remote_id)
 node_events=[json.loads(line) for line in (root/'.local-monitor/remote-live.log').read_text(encoding='utf8').splitlines() if line.startswith('{')]
 observed_hosts={event.get('host') for event in node_events if event.get('requestId')==remote_id}
 assert {'hpc','mnckoren','ai-cloud'}<=observed_hosts,'Fresh run logs must come from all three hosts'
 for title in rec.TITLES:
  for handle,name in rec.windows():
   if name==title:user.ShowWindow(handle,6)
 mark('서비스 모니터링');navigate('http://127.0.0.1:3200/?window=24h');time.sleep(2);tour();b.shot(video/'continuous-overview.png')
 scroll(0,1);b.click('nav a[data-page="evaluation"]');time.sleep(4)
 b.js('document.title='+json.dumps(b.title))
 check_monitor()
 for index,source in enumerate(['routing','longitudinal','reports','distributed']):
  mark('실행 평가 · '+source)
  select_source(index,source);time.sleep(2);tour();time.sleep(1);b.shot(video/f'continuous-{source}.png')
 mark('촬영 완료');time.sleep(2)
 assert time.monotonic()-started<239,'Recording exceeded continuous capture budget'
finally:
 if capture.poll() is None:capture.stdin.write(b'q');capture.stdin.flush();capture.wait(timeout=30)
 log.close()
assert capture.returncode==0
(video/'continuous-tour-events.json').write_text(json.dumps(events,ensure_ascii=False,indent=2),encoding='utf8')
print('Encoding at 0.8 speed',flush=True)
reader=f.imageio_ffmpeg.read_frames(str(raw));original=next(reader);reader.close()
assert original['duration']/0.8<300,'0.8 speed would exceed five minutes'
subprocess.run([ff,'-v','error','-y','-i',str(raw),'-an','-c:v','copy','-movflags','+faststart',str(normal)],check=True)
subprocess.run([ff,'-v','error','-y','-i',str(raw),'-vf','setpts=PTS/0.8','-r','25','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',str(target)],check=True)
reader=f.imageio_ffmpeg.read_frames(str(target));metadata=next(reader);reader.close()
assert metadata['duration']<300 and metadata['size']==(1920,1080)
info=subprocess.run([ff,'-hide_banner','-i',str(target)],capture_output=True,encoding='utf8',errors='replace').stderr
assert 'Audio:' not in info and 'Subtitle:' not in info
decode=subprocess.run([ff,'-v','error','-i',str(target),'-f','null','NUL'],capture_output=True)
assert decode.returncode==0 and not decode.stderr
normal_decode=subprocess.run([ff,'-v','error','-i',str(normal),'-f','null','NUL'],capture_output=True)
assert normal_decode.returncode==0 and not normal_decode.stderr
verification=dict(path=str(target),durationSeconds=metadata['duration'],normalSpeedPath=str(normal),normalSpeedDurationSeconds=original['duration'],size=metadata['size'],audioStreams=0,subtitleStreams=0,playbackSpeed=.8,freshContinuousCapture=True,insertedFootage=False,fullDecodePassed=True,bothVersionsDecodePassed=True,distributedRequestId=remote_id,distributedSubmittedThroughBrowser=True,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),events=events)
(video/'continuous-tour-verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(verification,ensure_ascii=False),flush=True)
