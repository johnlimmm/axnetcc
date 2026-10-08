# 로컬·KOREN 분산 구현 시연

2026-10-08 전용 시연 배포. 기존 9월 배포와 분리한 `axnetcc-showcase-20261008` 디렉터리와 포트를 사용한다.

## 접속 화면

| 실행 | 서비스 | 모니터 |
| --- | --- | --- |
| 같은 PC 로컬 실행 | http://127.0.0.1:3100 | http://127.0.0.1:3200/distributed |
| 실제 서버 분산 실행 | http://127.0.0.1:36100 | http://127.0.0.1:36200/distributed |

원격 URL은 `scripts/showcase-session.py serve` 관리 연결이 실행 중일 때 접근한다. 브라우저 접근과 로그 메타데이터 수집만 PC를 통과한다. Core→Edge 요청은 HPC→mnckoren 및 HPC→ai-cloud의 SSH 전달 경로를 이용한다.

| 노드 | 역할 | Agent / 전용 포트 |
| --- | --- | --- |
| HPC-VM | 중앙 라우팅·스케줄링·결과 통합 | 서비스 36100, 실험용 operator 36101, 모니터 36200 |
| mnckoren | 주 Edge | tech 6201, data 6202, security 6203, legal 6204, policy 6205, finance 6206, procurement 6207, operations 6208 |
| ai-cloud | 동일 논리 Agent 백업 | 같은 순서 6101~6108 |

세 노드의 전용 Ollama 포트는 14434다. 기존 모델 파일을 사용하며 기존 13434 추론 서비스는 수정하지 않는다. SSH 포트는 ai-cloud 31055다. 현재 역할 배치는 9월 초기 문서와 달라 실제 설정을 기준으로 한다.

## 촬영 흐름

바탕화면 `eucnc2025_demo.mp4`처럼 역할을 구분한 여러 터미널을 동시에 촬영한다. 웹의 기본 분산 화면은 성능 비교용이며 실행 로그·배치도는 표시하지 않는다. 필요할 때만 `/distributed?execution=1` 진단 화면을 사용한다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/open-showcase-terminals.ps1 -RunRequest
```

위 명령은 HPC 중앙(노랑), mnckoren 주 Agent(초록), ai-cloud 백업 Agent(파랑), 실제 공개 질의 실행(분홍)의 별도 Windows Terminal 창을 연다. 1920×1080 기준 네 모서리에 배치하며 화면 해상도에 따라 조절한다. 노드 창은 인증된 SSH로 수집한 실제 stdout을 호스트별로 구분한다. 처음의 최근 기록과 `LIVE` 이후 새 이벤트를 명확히 구분하며, 요청이 없는 백업 노드는 대기 상태로 둔다. 합성 로그나 과거 로그 재생을 실시간 실행으로 표시하지 않는다.

1. 로컬 서비스에서 공개 RAG 질의를 입력한다. Agent 선택, 진행 상태, 답변과 근거를 보여준다. “같은 PC의 로컬 Ollama를 공유하는 논리 Agent 실행”이라고 설명한다.
2. 분산 서비스로 전환한다. HPC·mnckoren·ai-cloud 배치 표와 현재 배포 ID를 보여준다.
3. 실행 장면에서는 여러 터미널을 나란히 배치한다. 공개 질의 실행 콘솔의 요청 ID를 중앙·노드 로그와 연결한다.
4. 노드 터미널에서 `edge-received → edge-completed/edge-failed`, 중앙 터미널에서 `core-attempt-completed`, `core-inference-completed`를 확인한다. host는 실제 로그를 생성한 서버이며 화면은 SSH 수집 결과다.
5. 노드별 TTFT·TPOT·생성 token/s, 대기·추론을 포함하는 시도 지연, 요청 준비/응답 수신 본문 바이트를 보여준다.
6. 독립 TCP 연결시간 그래프를 보여준다. 이 값은 HPC 관측점에서 노드 SSH 포트까지의 연결시간이며 LLM 생성 지표와 다르다.
7. 실험 비교 그래프에서 정상·주 경로 300ms 지연·주 경로 불가를 선택해 같은 질의의 여섯 기법을 비교한다. 장애 시 백업 노드 로그와 중앙 채택 기록을 연결한다.
8. 양쪽 경로 불가 시 성공으로 표시하지 않는지 보여주고, 복구 요청 및 원시 결과 파일로 마무리한다.

촬영용 공개 질문 예시:

> 공공부문 AI 도입 가이드(2026.5.)에서 RAG 도구의 파싱, 청킹, 임베딩, 검색 API 구성은 어떻게 설명하나요? 제공된 공개 근거에 있는 내용만 요약해 주세요.

## 계측 해석

- TTFT는 각 제공자 호출에서 첫 콘텐츠를 받기까지의 시간이다. 실행 전체나 브라우저의 첫 표시시간과 동일하지 않다.
- TPOT는 Ollama 생성 시간÷출력 토큰이다. Edge token/s는 전달받은 측정 TPOT의 역수이므로 원본 TPOT 반올림 오차가 있다. 중앙 호출은 제공자의 token/s를 보존한다.
- TCP 연결시간은 실제 연결 탐침이다. ICMP RTT·지터·패킷 손실·링크 대역폭을 측정한 것으로 해석하지 않는다.
- 본문 바이트는 애플리케이션 계측이다. 준비된 요청의 전달 성공이나 TLS/SSH/NIC 트래픽을 증명하지 않는다.
- 300ms 조건은 전용 gateway에서 주 경로 요청을 지연하는 애플리케이션 장애 주입이다. 물리 KOREN 링크 지연을 변경한 실험이 아니다.
- 노드 배치와 SSH 연결은 관측되지만, KOREN 물리 경로의 독립 검증에는 별도의 최신 라우팅/패킷 기록이 필요하다. 과거 패킷 캡처를 현재 표본으로 재사용하지 않는다.
- 실패·부분 실패·미측정 값을 삭제하거나 0으로 바꾸지 않는다. 표본 수와 측정 coverage를 같이 확인한다. 각 셀의 표본이 작으므로 일반적인 성능 우위나 안정적인 P95를 주장하지 않는다.
- 실험은 추론 실행 가능성을 비교한다. 생성 답변의 사실성·의미적 정확도 평가는 별도다.

## 실험과 재현

`scripts/run-showcase-campaign.py`는 HPC에서 실행한다. `centralized`, `parallel`, `managed`, `masrouter`, `remoterag`, `proposed`를 공개 질의 2개에 적용하며 정상·주 경로 지연·주 경로 장애를 비교한다. 이어 양쪽 경로 장애와 복구를 proposed로 확인한다. 계획 표본 수는 38건이며 동시 요청 수는 1이다. MasRouter/RemoteRAG는 저장소의 inspired 구현이다.

실행 중 모니터가 읽는 파일은 HPC의 `shared/campaign.json`이다. manifest, JSONL, 요청별 snapshot, 노드 stdout 로그를 보존하고 `scripts/showcase-session.py pull`로 `outputs/showcase-20261008/`에 내려받는다. 새 실험에서 기존 manifest를 덮어쓰지 않는다.

추론 종료가 불확실하면 새 요청을 중단한다. `showcase-session.py recover` 관리 프로세스가 각 노드의 전용 모델 PID·cwd·실행 인자·프로세스 그룹을 검증하고 전용 그룹의 종료를 확인한 뒤 재시작·예열한다. 이 복구 증거가 없으면 캠페인이 중단된다. 실패 표본은 유지하고 복구 시간은 요청 지연과 분리한다.

준비 중 발견한 만료된 9월 TLS 인증서, 종료된 ai-cloud 추론 프로세스, 예열 전/공유 추론기의 시간 초과 표본은 별도 diagnostic 폴더에 보존한다. 현재 성공 표본으로 바꾸거나 본 실험에 합치지 않는다.

## 로그를 터미널에서 함께 보기

새 연속 녹화에는 `scripts/demo-browser-proxy.py`를 먼저 실행하고, `scripts/prepare-live-log-scene.py`로 네 로그 창을 준비한 뒤 `scripts/record-continuous-tour.py`를 실행한다. 준비·녹화 스크립트에는 `--credential-session <승인된 로컬 세션 파일 경로>` 또는 `DEMO_CREDENTIAL_SESSION` 환경 변수를 전달한다. 인증 세션 파일과 개인키는 저장소에 넣지 않는다.

녹화는 동일한 로컬 입력 화면에서 로컬 API와 실제 HPC API를 순서대로 사용한다. 결과 보고서와 펼친 Agent 선택 이유, 실제 분산 요청의 네 로그 창, 자동 갱신 중인 모니터링과 네 평가 화면을 연속 촬영한다. 1배속 원본이 4분 미만인지 먼저 검사하고 0.8배속 파일을 만든다. 두 파일 모두 무음·무자막이며 기존 영상 조각을 삽입하지 않는다. 이전 설명 자막은 별도 텍스트로 보관한다.

Windows 관리 프로세스가 수집한 실제 노드 메타데이터 로그:

```powershell
Get-Content .local-monitor/remote-live.log -Wait -Tail 30
```

서버에서 직접 볼 때는 각 노드의 `~/axnetcc-showcase-20261008/logs/edge-<agent>.log`, 중앙의 `logs/operator.log` 또는 `logs/service.log`를 사용한다. `EXECUTION_LOG_ENABLED=true` 로그는 요청 본문·프롬프트·토큰·원문 오류를 포함하지 않는다.
