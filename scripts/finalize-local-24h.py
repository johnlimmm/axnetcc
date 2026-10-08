"""After collection: export analysis/figures and record real clicks, then compose silent demo."""
import base64, ctypes, importlib.util, json, os, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports/local-evaluation'; VIDEO=ROOT/'outputs/video-production'
DEST=Path('C:/Users/Daesik/Dropbox/26-3Q 여름방학/넷 챌린지')
sys.path.insert(0,str(ROOT/'outputs/video-review-tools'))
import imageio_ffmpeg, websocket
from PIL import Image,ImageDraw,ImageFont
sys.stdout.reconfigure(encoding='utf8')

class Browser:
    def __init__(self):
        try:
            with urlopen('http://127.0.0.1:9229/json/list',timeout=5) as r: pages=json.load(r)
        except Exception:
            edge=Path('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
            subprocess.Popen([str(edge),'--remote-debugging-port=9229','--user-data-dir='+str(VIDEO/'final-browser-profile'),'--app=http://127.0.0.1:3200/evaluation','--no-first-run'])
            time.sleep(5)
            with urlopen('http://127.0.0.1:9229/json/list',timeout=5) as r: pages=json.load(r)
        page=next(p for p in pages if p['type']=='page' and '127.0.0.1' in p['url'])
        self.socket=websocket.create_connection(page['webSocketDebuggerUrl'],timeout=30,suppress_origin=True);self.seq=0
        self.title='MNC LAB DEMO FINAL '+page['id'][:8]
    def call(self,name,params=None):
        self.seq+=1;sid=self.seq;self.socket.send(json.dumps(dict(id=sid,method=name,params=params or {})))
        while True:
            item=json.loads(self.socket.recv())
            if item.get('id')==sid:
                if 'error' in item:raise RuntimeError(item['error'])
                return item.get('result',{})
    def js(self,expr):
        r=self.call('Runtime.evaluate',dict(expression=expr,returnByValue=True,awaitPromise=True))
        if r.get('exceptionDetails'):raise RuntimeError(r['exceptionDetails'])
        return r.get('result',{}).get('value')
    def navigate(self,url):
        self.call('Page.navigate',dict(url=url));time.sleep(4)
        self.js('document.title='+json.dumps(self.title)+';document.documentElement.style.zoom="100%"')
        spec=importlib.util.spec_from_file_location('rec',ROOT/'scripts/record-showcase-video.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
        self.hwnd=mod.move(self.title,0,0,1920,1080)
        self.window_title=next(name for handle,name in mod.windows() if handle==self.hwnd)
    def click(self,selector,optional=False):
        rect=self.js('(()=>{const e=document.querySelector('+json.dumps(selector)+');if(!e)return null;e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,sx:screenX,sy:screenY,top:outerHeight-innerHeight};})()')
        if not rect:
            if optional:return
            raise RuntimeError('Missing interaction target '+selector)
        ctypes.windll.user32.SetCursorPos(int(rect['sx']+rect['x']),int(rect['sy']+rect['top']+rect['y']));time.sleep(.7)
        for event in ['mousePressed','mouseReleased']:
            self.call('Input.dispatchMouseEvent',dict(type=event,x=rect['x'],y=rect['y'],button='left',clickCount=1))
        time.sleep(.5)
    def key(self,key,code):
        for kind in ['keyDown','keyUp']:self.call('Input.dispatchKeyEvent',dict(type=kind,key=key,code=key,windowsVirtualKeyCode=code))
    def select_longitudinal(self):
        ctypes.windll.user32.SetForegroundWindow(self.hwnd)
        self.click('#evaluation-source')
        self.key('Escape',27)
        ctypes.windll.user32.mouse_event(2,0,0,0,0)
        ctypes.windll.user32.mouse_event(4,0,0,0,0)
        time.sleep(.5)
        # Native popup receives Windows keyboard input rather than page CDP events.
        for code in [36,40,13]:
            ctypes.windll.user32.keybd_event(code,0,0,0)
            ctypes.windll.user32.keybd_event(code,0,2,0)
            time.sleep(.3)
        time.sleep(2)
        assert self.js('document.querySelector("#evaluation-source").value')=='longitudinal'
    def shot(self,path):
        payload=self.call('Page.captureScreenshot',dict(format='png',captureBeyondViewport=False))
        path.write_bytes(base64.b64decode(payload['data']))

def analyze(summary):
    lines=['로컬 반복 실행 — 결과와 해석',f"상태: {summary['status']} / 저장 표본: {summary['sampleCount']}",f"시작: {summary['startedAt']} / 마지막 갱신: {summary['updatedAt']}",'',
      '조건: 로컬 qwen2.5:3b, 요청 동시성 1, 개발 질의 40개와 별도 사실 질문 12개, 질의별 기법 순서 무작위화.',
      '비교: centralized/managed/parallel/proposed. 원 논문을 완전히 재현하지 않은 MasRouter/RemoteRAG는 이번 주 비교에서 제외했다.',
      '같은 질의를 반복한 표본은 독립 질문이 아니다. Agent F1은 선택 집합 일치도이며 의미적 답변 정확도가 아니다.',
      'E2E·호출 수·생성 토큰 그래프는 완료되고 LLM 대체가 없는 실행만 집계한다. 완료/실패/대체 분모는 표에 별도로 유지한다.',
      '정답 사실 충족률은 공개 문서의 정답 사실 17항목을 사전 고정한 12문항의 규칙 판정이다. 전체 의미 정확도와 다르며 미인식 표현과 추가 허위 주장은 별도 검토가 필요하다.',
      '중앙집중 방식의 evidence-projection은 정상적인 근거 매핑이며 LLM 대체로 분류하지 않는다.',
      '모드별 추론·합성 구조가 달라 전체 지연 차이를 라우팅만의 인과 효과로 단정하지 않는다.','']
    for r in summary['rows']:
        lines.append(f"{r['mode']}: 전체 {r['n']}, 완료 {r['completed']}, 실제 LLM 완료 {r['realLlmCompleted']}, 대체 {r['fallback']}, 고유 질의 {r['uniqueQueries']}, 실제 LLM 완료 평균 E2E {r['latencyMs']}ms, Agent F1 {r['agentF1']}, 평균 호출 {r['calls']}, 생성 토큰 {r['tokens']}")
        lines.append(f"정답 사실 충족률: {r.get('factCoverage')}% / 채점 실행 {r.get('factSamples',0)}건. 같은 질문의 반복 실행을 포함한 잠정 집계이며, 수집 종료 후 전체 질문을 기준으로 비교한다.")
    lines+=['','원인 해석:',
      '전체 Agent 실행은 선택한 Agent와 공유 모델 자원의 작업량이 많다. 요청 제출의 병렬성과 모델의 실제 동시 추론을 구분해야 한다.',
      '선택 라우팅은 호출량을 줄일 수 있지만, 선택 누락이나 답변 품질 저하가 없는지 별도 검증이 필요하다.',
      '중앙집중형은 Agent별 생성 대신 근거 매핑과 중앙 생성을 사용하므로 호출 구조가 다르다. 빠른 결과만으로 동일 작업의 우위를 주장할 수 없다.',
      'TTFT/TPOT는 모델 제공자 계측이고 TCP 연결시간이나 KOREN 회선 처리량이 아니다.',
      '반복 중 출력 길이·캐시·모델 대기열·PC의 다른 작업이 영향을 줄 수 있다. 질의 단위의 평균과 실패·대체 비율을 함께 해석한다.',
      '원시 스냅샷, append-only measurements.jsonl, 실행 설정 manifest.json, 재분류 집계 summary.json은 reports/local-evaluation에 보존한다.']
    (DEST/'성능평가_로컬반복_결과분석.txt').write_text('\n'.join(lines),encoding='utf8')

def main():
    summary=json.loads((OUT/'summary.json').read_text(encoding='utf8'));assert summary['sampleCount']>0
    analyze(summary)
    if '--analysis-only' in sys.argv:return
    b=Browser()
    records=[json.loads(v) for v in (OUT/'measurements.jsonl').read_text(encoding='utf8').splitlines()]
    latest=next(r for r in reversed(records) if r['mode']=='proposed' and r.get('status')=='completed' and r.get('metricsComplete') and r.get('realLlm') and (r.get('routerDecision') or {}).get('primarySelection'))
    b.navigate('http://127.0.0.1:3100/')
    assert b.js('!!document.querySelector("#work-request")'),'Question input unavailable'
    ff=imageio_ffmpeg.get_ffmpeg_exe();capture=VIDEO/'local-24h-interactions.mp4'
    log=(VIDEO/'local-24h-capture.log').open('wb')
    ctypes.windll.user32.ShowWindow(b.hwnd,9)
    ctypes.windll.user32.keybd_event(18,0,0,0)
    ctypes.windll.user32.keybd_event(18,0,2,0)
    ctypes.windll.user32.SetForegroundWindow(b.hwnd)
    time.sleep(1)
    assert ctypes.windll.user32.GetForegroundWindow()==b.hwnd,'Owned recording window must be foreground'
    proc=subprocess.Popen([ff,'-y','-f','gdigrab','-framerate','15','-draw_mouse','1','-offset_x','0','-offset_y','0','-video_size','1920x1080','-i','desktop','-t','220','-an','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p',str(capture)],stdin=subprocess.PIPE,stdout=log,stderr=log)
    start=time.monotonic();events=[]
    def mark(label):events.append(dict(at=time.monotonic()-start,label=label))
    try:
        mark('민원 질문 직접 입력');time.sleep(3)
        b.click('#work-request')
        question='공공기관 민원 상담에 AI를 도입하려고 합니다. 주민의 개인정보를 외부 AI에 보내도 되는지, 도입 전에 무엇을 확인해야 하는지 알려주세요.'
        for character in question:
            b.call('Input.insertText',dict(text=character));time.sleep(.08)
        assert b.js('document.querySelector("#work-request").value')==question
        time.sleep(3);b.click('.primaryRequestButton');mark('Agent 선택 · 근거 검색 · 답변 생성')
        for _ in range(120):
            if b.js('!!document.querySelector(".scoreDetails summary")'):break
            time.sleep(1)
        else:raise RuntimeError('Live request did not produce selection details')
        mark('로컬 실행 결과');time.sleep(8)
        b.js('document.querySelector("[data-testid=routing-explanation]").scrollIntoView({block:"start"})');mark('Agent 선택 이유');time.sleep(10)
        b.click('.scoreDetails summary');assert b.js('document.querySelector(".scoreDetails").open');mark('점수 구성 확인');time.sleep(10)
        b.click('.candidateComparison summary');assert b.js('document.querySelector(".candidateComparison").open');mark('전체 후보 비교');time.sleep(10)
        b.shot(VIDEO/'local-24h-routing-reasons.png')
        split=time.monotonic()-start
        b.navigate('http://127.0.0.1:3200/evaluation');mark('실행 평가');time.sleep(6)
        b.select_longitudinal()
        assert b.js('document.querySelector("#evaluation-source").value')=='longitudinal'
        mark('반복 실측 비교');time.sleep(12)
        b.shot(VIDEO/'local-24h-final-graphs.png')
        figures=b.js('[...document.querySelectorAll(".paperFigure svg")].map(e=>e.outerHTML)')
        for i,svg in enumerate(figures):
            svg=svg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ').replace('class="figureValue"','font-weight="bold"')
            (DEST/f'실행평가_그래프_{i+1}.svg').write_text(svg,encoding='utf8')

        b.js('document.querySelectorAll(".paperFigure")[4].scrollIntoView({block:"center"})');mark('정답 사실 비교 · 그래프 다운로드');time.sleep(6)
    finally:
        if proc.poll() is None:proc.stdin.write(b'q');proc.stdin.flush();proc.wait(timeout=30)
        log.close()
    assert proc.returncode==0
    from PIL import ImageStat
    frames=imageio_ffmpeg.read_frames(str(capture));capture_meta=next(frames);first=next(frames);frames.close()
    assert max(ImageStat.Stat(Image.frombytes('RGB',capture_meta['size'],first)).stddev)>8,'Window capture blank; keep report and fail video validation'
    (VIDEO/'local-24h-interactions.json').write_text(json.dumps(dict(splitAt=split,events=events),ensure_ascii=False,indent=2),encoding='utf8')
    compose(capture,split,events)

def compose(capture,split,events):
    target=DEST/'최종평가시연동영상_MNC Lab_실행평가_설명자막본.mp4'
    writer=imageio_ffmpeg.write_frames(str(target),(1920,1080),fps=15,codec='libx264',quality=8,macro_block_size=1,output_params=['-preset','fast','-an','-movflags','+faststart']);writer.send(None)
    font=ImageFont.truetype('C:/Windows/Fonts/malgun.ttf',34);bold=ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf',28)
    count=0
    def emit(raw,size,title,line1,line2):
        nonlocal count
        image=Image.new('RGB',(1920,1080),'#ffffff');image.paste(Image.frombytes('RGB',size,raw).resize((1680,945),Image.Resampling.LANCZOS),(120,0))
        d=ImageDraw.Draw(image);d.line((120,950,1800,950),fill='#8f171a',width=3)
        for at,text,ft,color in [(956,title,bold,'#8f171a'),(990,line1,font,'#111111'),(1032,line2,font,'#111111')]:
            assert d.textlength(text,font=ft)<1680,text;d.text((120,at),text,font=ft,fill=color)
        writer.send(image.tobytes());count+=1
    try:
        for section in ['service','distributed','evaluation']:
            source=VIDEO/'silent-demo-capture.mp4' if section=='distributed' else capture
            r=imageio_ffmpeg.read_frames(str(source));meta=next(r)
            for i,raw in enumerate(r):
                at=i/meta['fps']
                if section=='service' and at>=split:break
                if section=='distributed' and not 24<=at<89:continue
                if section=='evaluation' and at<split:continue
                if section=='service':
                    current=next((event['label'] for event in reversed(events) if event['at']<=at),'민원 질문 직접 입력')
                    title='로컬 실행 · '+current;l1='민원 상담 AI 도입과 개인정보 처리에 관한 질문을 직접 입력해 실행합니다.';l2='질문 입력부터 답변 생성, Agent 선택 이유와 후보 비교까지 실제 동작입니다.'
                elif section=='distributed':
                    title='실제 분산 실행 기록 · 2026.10.08 촬영';l1='HPC 중앙 오케스트레이터 · mnckoren 주 Agent · ai-cloud 백업 Agent';l2='실제 SSH 수집 로그입니다. 이 장면은 로컬 반복 성능 비교와 별개인 배치 시연입니다.'
                else:
                    title='로컬 반복 실행 평가';l1='동일 모델·동일 개발 질의를 반복하고, 기법 순서를 섞어 실제 실행 결과를 수집했습니다.';l2='품질·지연·호출량과 완료·대체 비율을 함께 확인합니다. 반복 횟수는 고유 질의 수와 다릅니다.'
                emit(raw,meta['size'],title,l1,l2)
            r.close()
    finally:writer.close()
    r=imageio_ffmpeg.read_frames(str(target));meta=next(r);r.close();assert meta['duration']<300
    ff=imageio_ffmpeg.get_ffmpeg_exe()
    info=subprocess.run([ff,'-hide_banner','-i',str(target)],capture_output=True,encoding='utf8',errors='replace').stderr;assert 'Audio:' not in info
    decode=subprocess.run([ff,'-v','error','-i',str(target),'-f','null','NUL'],capture_output=True);assert decode.returncode==0 and not decode.stderr
    (OUT/'video-verification.json').write_text(json.dumps(dict(path=str(target),durationSeconds=meta['duration'],audioStreams=0,fullDecodePassed=True,cursorCapture=True,historicalDistributedClip=True),ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
