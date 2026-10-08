"""Create a silent explanatory edition from the verified actual screen capture."""
from pathlib import Path
import sys, json, subprocess, hashlib
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'outputs/video-review-tools'))
import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = ROOT / 'outputs/video-production'
SOURCE = OUT / 'silent-demo-capture.mp4'
TARGET = Path('C:/Users/Daesik/Dropbox/26-3Q 여름방학/넷 챌린지/최종평가시연동영상_MNC Lab_설명자막본.mp4')
FONT = ImageFont.truetype('C:/Windows/Fonts/malgun.ttf', 34)
BOLD = ImageFont.truetype('C:/Windows/Fonts/malgunbd.ttf', 27)
STAGES = [
 (0, '01  로컬 서비스 실행', '질의를 입력하면 필요한 업무 Agent를 선택하고 근거를 수집합니다.', 'Agent별 처리 결과를 중앙 오케스트레이터가 하나의 답변으로 통합합니다.'),
 (14, '02  로컬 실행 결과 확인', '근거와 통합 답변이 완성된 화면입니다.', '이 장면은 한 PC에서 로컬 모델을 공유해 실행한 결과입니다.'),
 (24, '03  실제 분산 노드 실행', 'HPC: 중앙 오케스트레이터  /  mnckoren: 주 Agent  /  ai-cloud: 백업 Agent', '노드별 터미널에서 같은 요청 ID의 수신·추론·완료 로그를 확인합니다.'),
 (39, '04  주 경로 장애와 백업 전환', '전용 gateway의 주 경로를 차단하면 ai-cloud의 백업 Agent를 호출합니다.', '물리 회선 장애가 아닌 애플리케이션 경로 장애를 주입한 시나리오입니다.'),
 (83, '05  백업 실행 완료', 'ai-cloud의 추론 결과를 HPC가 받아 최종 응답을 통합했습니다.', '각 노드 로그의 요청 ID로 장애 감지부터 백업 처리까지 연결해 확인합니다.'),
 (89, '06  비교 실험 결과', '공개 질의 2개 × 6개 기법 × 3조건에 장애·복구 2건을 더해 총 38건을 실행했습니다.', '기법·조건당 표본은 2건이며, 지연과 함께 완료율·실패 건수도 확인합니다.'),
 (99, '07  첫 토큰 지연 · TTFT', 'TTFT는 모델 제공자가 첫 콘텐츠를 생성하기까지 걸린 시간입니다.', '사용자 화면의 첫 출력 시간이나 네트워크 RTT와는 측정 범위가 다릅니다.'),
 (107, '08  토큰 생성 성능 · TPOT / token/s', 'TPOT는 토큰 1개당 생성 시간, token/s는 모델 제공자의 초당 생성 토큰 수입니다.', '모델·GPU/CPU·대기열의 영향을 받으며, 망 대역폭을 뜻하는 값은 아닙니다.'),
 (122, '09  지연 주입 시나리오', '주 경로 gateway에 300ms의 애플리케이션 지연을 추가한 조건입니다.', '모델 추론과 대기열도 함께 작용하므로 최종 지연 차이가 항상 300ms는 아닙니다.'),
 (129, '10  장애 조건 비교', '주 경로 장애 시 CPU 백업의 추론 속도와 요청 마감 시간이 결과에 영향을 줍니다.', '기법마다 처리 작업량이 다르므로 완료율과 지연을 함께 비교합니다.'),
 (144, '11  노드 간 TCP 연결 성능', 'HPC에서 각 노드의 SSH 포트까지 TCP 연결 시간을 별도로 측정합니다.', '이 측정만으로 KOREN의 물리 경로나 회선 대역폭을 증명하지는 않습니다.'),
 (154, '12  노드별 모델 성능 확인', '노드별 TTFT·TPOT·token/s를 통해 분산 실행의 병목을 비교합니다.', '이번 결과는 소규모 파일럿이며, 상세 수치와 원인 분석은 별도 텍스트에 정리했습니다.'),
]
HOLDS = {round(t * 15): 7 for t in [20, 36, 85, 104, 118, 126, 140, 150, 161]}

def render(raw, at, frozen=False):
    stage = next(s for s in reversed(STAGES) if at >= s[0])
    canvas = Image.new('RGB', (1920, 1080), '#0b1220')
    screen = Image.frombytes('RGB', (1920,1080), raw).resize((1680,945), Image.Resampling.LANCZOS)
    canvas.paste(screen, (120,0))
    draw = ImageDraw.Draw(canvas)
    draw.line((96,950,1824,950), fill='#334155', width=2)
    draw.text((120,955), stage[1], font=BOLD, fill='#63d9ef')
    if frozen:
        draw.text((1540,955), '화면 정지 · 설명', font=BOLD, fill='#facc15')
    draw.text((120,988), stage[2], font=FONT, fill='white')
    draw.text((120,1030), stage[3], font=FONT, fill='white')
    for line in stage[2:]:
        assert draw.textlength(line, font=FONT) <= 1680, line
    return np.asarray(canvas).tobytes()

def main():
    reader = imageio_ffmpeg.read_frames(str(SOURCE), pix_fmt='rgb24')
    meta = next(reader)
    assert meta['size'] == (1920,1080) and meta['fps'] == 15
    writer = imageio_ffmpeg.write_frames(str(TARGET), (1920,1080), fps=15, codec='libx264',
        quality=8, pix_fmt_in='rgb24', pix_fmt_out='yuv420p', macro_block_size=1,
        output_params=['-preset','fast','-movflags','+faststart','-an'])
    writer.send(None)
    count = 0
    stills = []
    try:
        for i, raw in enumerate(reader):
            at = i / 15
            writer.send(render(raw, at)); count += 1
            if i in HOLDS:
                held = render(raw, at, True)
                path = OUT / f'explained-review-{i}.png'
                Image.frombytes('RGB',(1920,1080),held).save(path)
                stills.append(str(path))
                for _ in range(HOLDS[i] * 15):
                    writer.send(held); count += 1
                print(f'Caption hold: source={at:.1f}s output={count/15:.1f}s', flush=True)
    finally:
        reader.close(); writer.close()
    verify(stills)

def verify(stills):
    check = imageio_ffmpeg.read_frames(str(TARGET)); result = next(check); check.close()
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    info = subprocess.run([ffmpeg,'-hide_banner','-i',str(TARGET)], capture_output=True, text=True, encoding='utf8', errors='replace').stderr
    assert 'Audio:' not in info and result['duration'] < 300
    decode = subprocess.run([ffmpeg,'-v','error','-i',str(TARGET),'-f','null','NUL'], capture_output=True, text=True, encoding='utf8', errors='replace')
    assert decode.returncode == 0 and not decode.stderr.strip(), decode.stderr
    evidence = dict(path=str(TARGET), durationSeconds=result['duration'], audioStreams=0,
        fullDecodePassed=True, freezeHoldsSeconds=sum(HOLDS.values()), reviewFrames=stills,
        bytes=TARGET.stat().st_size, sha256=hashlib.sha256(TARGET.read_bytes()).hexdigest())
    (OUT/'explained-video-verification.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(evidence,ensure_ascii=False),flush=True)

if __name__ == '__main__':
    if '--verify' in sys.argv: verify([str(p) for p in sorted(OUT.glob('explained-review-*.png'))])
    else: main()
