# MNC FLOW

공공기관·기업 AX를 위한 **분산형 Multi-Agent RAG 거버넌스 프로토타입**입니다.  
Core가 질의를 분석해 필요한 전문 Agent만 선택하고, 각 Agent는 자신에게 허용된 문서와 독립적인 로컬 LLM endpoint를 사용합니다. 원문을 중앙으로 모으지 않고 최소 결과와 근거 식별자만 통합하는 구조를 실험합니다.

## 현재 구현 범위

- 기술·데이터·보안·법무·정책·재무·조달·운영 등 8개 전문 Agent
- 질의 기반 동적 Agent 선택
- Agent별 독립 Ollama endpoint와 모델 설정
- Agent별 허용 범위를 적용한 로컬 RAG
- 직접 식별자 마스킹과 근거 ID 연결
- 중앙집중형, 전체 Multi-Agent, MasRouter-inspired, RemoteRAG-inspired, 제안 방식의 동일 질의 비교
- E2E latency, TTFT, TPOT, Core 전송량, 원문 외부 전송 여부 측정
- 선택적으로 OpenAI 호환 상용 LLM을 블라인드 평가자로 사용
- 반복평가 페이지: `/evaluation`
- 서비스·연구 설명 페이지: `/about`

## 검증된 반복평가 결과

문헌 기반 baseline 추가 후 5개 복합 질의를 다섯 방식에 각각 3회 적용해 총 75개 결과를 비교했습니다.

| 방식 | 종합 품질 평균 | 표준편차 | TTFT | TPOT | Core 전송량 | 원문 외부 전송 |
|---|---:|---:|---:|---:|---:|---|
| Single Centralized RAG | 81.6 | 5.1 | 18.36초 | 110.9ms | 52,788B | 있음 |
| All-Agent Aggregation | 81.3 | 4.9 | 5.69초 | 157.4ms | 6,718B | 없음 |
| MasRouter-inspired | 74.1 | 5.5 | 2.21초 | 133.4ms | 1,426B | 있음 |
| RemoteRAG-inspired | 70.0 | 10.3 | 4.58초 | 104.0ms | 4,649B | 있음 |
| 제안 방식 | 76.5 | 4.7 | 3.78초 | 152.2ms | 3,479B | 없음 |

현재 환경에서 제안 방식은 최고 품질의 93.8%를 유지하면서 전체 Multi-Agent 대비 Core 전송량을 48.2% 줄였습니다. MasRouter-inspired보다 품질이 2.4점, RemoteRAG-inspired보다 6.5점 높았고 원문 비이동을 유지했습니다. 두 inspired baseline은 원 논문의 전체 학습 controller 또는 DistanceDP를 재현한 것이 아니라 공개된 핵심 메커니즘을 동일 환경에 맞춰 구현한 비교군입니다. 이는 현재 평가셋과 장비에 대한 실측 결과이며 모든 환경에 대한 일반화된 성능 보장은 아닙니다.

실험 원자료 요약은 `data/evaluation/literature-baseline-report.json`, 국내 학술대회 2쪽 초안과 재생성 스크립트는 `paper/`에 있습니다.

## 구조

```text
Browser
  │
  ▼
Core Web/API (:3000)
  ├─ 질의 정제 및 식별자 마스킹
  ├─ Agent 동적 선택
  ├─ 최소 결과 통합
  └─ 지표 및 감사정보 생성
       │
       ├─ Tech Edge       → Ollama + Tech RAG
       ├─ Data Edge       → Ollama + Data RAG
       ├─ Security Edge   → Ollama + Security RAG
       ├─ Legal Edge      → Ollama + Legal RAG
       ├─ Policy Edge     → Ollama + Policy RAG
       ├─ Finance Edge    → Ollama + Finance RAG
       ├─ Procurement Edge→ Ollama + Procurement RAG
       └─ Operations Edge → Ollama + Operations RAG
```

Core와 Edge를 한 PC에서 실행할 수도 있고, Agent별 endpoint를 서로 다른 PC·GPU 서버·KOREN 노드에 배치할 수도 있습니다. Core 코드는 배치 형태와 무관하며 환경변수의 주소만 변경합니다.

## 저장소 구성

```text
app/                     웹 UI와 API
lib/                     오케스트레이션, RAG, 로컬 LLM, 평가 로직
data/rag-corpus.json     실행용 RAG corpus
data/manifest.jsonl      수집 데이터 manifest
data/evaluation/         golden set과 최신 오프라인 평가 결과
corpus/sources.json      공개 데이터 출처 목록
docs/                    데이터 수집·평가·배치 참고문서
scripts/                 Edge 실행, 상태점검, corpus 빌드, 반복평가
tests/                   오케스트레이터 회귀 테스트
worker/                  Cloudflare/Vinext Worker 진입점
```

`corpus/raw`, `corpus/processed`, `corpus/index`, `.local-edge`, `.env.local`, 빌드 결과와 로그는 Git에 포함하지 않습니다.

## 요구사항

### 공통

- Git
- Node.js 22.13 이상
- pnpm 10 이상
- Ollama
- 최소 8GB RAM 권장

CPU만 있는 PC에서는 기본값인 `qwen2.5:0.5b`를 권장합니다. GPU 서버에서는 Agent별 모델을 `qwen2.5:3b` 이상으로 교체할 수 있지만, 방식 비교 시에는 모든 방식에 동일 모델을 사용해야 합니다.

## 1. 다른 PC에서 한 번에 실행

### 저장소 준비

```bash
git clone <REPOSITORY_URL>
cd platform
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Windows PowerShell에서는 다음처럼 복사할 수 있습니다.

```powershell
Copy-Item .env.example .env.local
```

### 모델 준비

```bash
ollama pull qwen2.5:0.5b
```

기본 설정은 Agent별로 `11441`부터 `11448`까지 8개의 독립 Ollama 서버를 사용합니다.

Windows:

```powershell
pnpm run edge:start
pnpm run local:check
pnpm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다.

종료:

```powershell
pnpm run edge:stop
```

`edge:start`는 `OLLAMA_EXE` 환경변수가 있으면 해당 실행파일을 사용하고, 없으면 `PATH`에서 `ollama`를 찾습니다.

### 단일 Ollama endpoint로 간단히 실행

8개 프로세스가 부담되면 `.env.local`의 Agent별 `LOCAL_LLM_*_BASE_URL`을 모두 동일한 Ollama 주소로 바꿀 수 있습니다.

```dotenv
LOCAL_LLM_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_MODEL=qwen2.5:0.5b
LOCAL_LLM_TECH_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_DATA_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_SECURITY_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_LEGAL_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_POLICY_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_FINANCE_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_PROCUREMENT_BASE_URL=http://127.0.0.1:11434
LOCAL_LLM_OPERATIONS_BASE_URL=http://127.0.0.1:11434
```

이 구성은 기능 확인에는 적합하지만 Agent별 장애·자원·네트워크 격리를 검증하는 배치와는 다릅니다.

## 2. Core와 Edge를 여러 장비에 분산 배치

### Edge 장비

각 Edge 장비에 Ollama를 설치하고 모델을 받은 뒤 내부망 주소로 서버를 엽니다.

Linux 예시:

```bash
ollama pull qwen2.5:0.5b
OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=15m ollama serve
```

운영환경에서는 위 명령을 직접 노출하지 말고 systemd, 컨테이너 오케스트레이터 또는 내부 AI gateway로 관리하십시오.

Edge별 권장 사항:

- Core의 사설 IP 또는 서비스 계정만 `11434` 접근 허용
- 인터넷에 Ollama API 직접 공개 금지
- TLS와 인증이 필요하면 Nginx, Envoy 또는 조직 표준 API gateway 사용
- Agent별 모델·문서 index·로그 디렉터리 분리
- 입력 원문과 로그의 보존기간 및 접근권한 설정
- `/api/tags`와 `/api/chat` 상태 모니터링

### Core 장비

Core의 `.env.local`에서 Agent별 주소를 실제 Edge 주소로 바꿉니다.

```dotenv
LOCAL_LLM_TECH_BASE_URL=http://10.20.1.41:11434
LOCAL_LLM_DATA_BASE_URL=http://10.20.1.42:11434
LOCAL_LLM_SECURITY_BASE_URL=http://10.20.1.43:11434
LOCAL_LLM_LEGAL_BASE_URL=http://10.20.1.44:11434
LOCAL_LLM_POLICY_BASE_URL=http://10.20.1.45:11434
LOCAL_LLM_FINANCE_BASE_URL=http://10.20.1.46:11434
LOCAL_LLM_PROCUREMENT_BASE_URL=http://10.20.1.47:11434
LOCAL_LLM_OPERATIONS_BASE_URL=http://10.20.1.48:11434
```

설정 확인:

```bash
pnpm run local:check
pnpm run build
pnpm run start
```

운영 기본 포트는 `3000`입니다. 방화벽에서는 사용자→Core의 웹 포트와 Core→Edge의 Ollama 포트만 허용합니다. Edge 간 직접 통신은 현재 구현에 필요하지 않습니다.

## 3. 컨테이너·클라우드 배치

Core는 Node/Vinext 애플리케이션으로 배치합니다.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run start
```

필수 운영 원칙:

1. `.env.local`이나 API key를 이미지에 복사하지 않습니다.
2. 환경변수는 Secret Manager, Kubernetes Secret 또는 배포 플랫폼의 runtime secret으로 주입합니다.
3. Core에서 모든 Edge endpoint로 outbound 연결이 가능한지 확인합니다.
4. 사설 Edge에 연결하려면 VPC peering, VPN, KOREN 사설망 또는 인증 tunnel을 사용합니다.
5. Core와 Edge의 시계를 NTP로 동기화해야 지연·감사 지표를 비교할 수 있습니다.
6. 자동 재시작, readiness probe, 중앙 로그 수집과 자원 제한을 설정합니다.

### Cloudflare/Sites 배치 시 주의

이 저장소에는 Vinext Worker 구성이 포함되어 있어 정적 UI와 API를 Cloudflare 호환 환경으로 빌드할 수 있습니다. 단, 클라우드 Worker가 `127.0.0.1` 또는 사설망의 Ollama에 직접 접근할 수는 없습니다.

실제 클라우드 배치에서는 다음 중 하나가 필요합니다.

- 인증된 HTTPS Edge gateway를 KOREN/VPN 경계에 배치
- Cloudflare Tunnel과 Access policy 사용
- Core API는 기관 VPC에 두고 정적 UI만 외부 호스팅

공개 endpoint를 사용할 때는 반드시 TLS, 인증, 요청 크기 제한, rate limit, 감사로그를 적용하십시오.

## 4. 환경변수

전체 예시는 `.env.example`에 있습니다.

| 변수 | 설명 |
|---|---|
| `LOCAL_LLM_BASE_URL` | Agent별 주소가 없을 때 사용하는 기본 Ollama endpoint |
| `LOCAL_LLM_MODEL` | 기본 모델 |
| `LOCAL_LLM_TIMEOUT_MS` | 로컬 LLM 요청 timeout |
| `LOCAL_LLM_<AGENT>_BASE_URL` | 특정 Agent의 독립 endpoint |
| `LOCAL_LLM_<AGENT>_MODEL` | 특정 Agent의 모델 |
| `COMMERCIAL_JUDGE_BASE_URL` | 선택적 OpenAI 호환 블라인드 평가 API |
| `COMMERCIAL_JUDGE_API_KEY` | 평가 API key. Git 커밋 금지 |
| `COMMERCIAL_JUDGE_MODEL` | 평가 모델 |

상용 평가를 켜면 질의, 생성 요약과 검색 근거 일부가 외부 평가 API로 전송됩니다. 민감한 운영 데이터에서는 기본적으로 비활성화하십시오.

## 5. RAG 데이터 갱신

공개 데이터 출처는 `corpus/sources.json`, 실행 corpus는 `data/rag-corpus.json`, 문서 manifest는 `data/manifest.jsonl`에 저장됩니다.

```bash
pnpm run rag:compile
```

원본 수집물과 처리 중간파일은 용량·저작권·개인정보 문제로 Git에서 제외합니다. 다른 환경에서 동일 corpus를 재생성하려면 조직 내부 저장소에서 원본을 안전하게 전달한 뒤 수집·처리 스크립트를 실행하십시오.

새 데이터를 추가할 때 확인할 항목:

- 출처 URL, 문서명, 발행기관, 기준일, 이용조건
- 문서 분류와 접근 가능한 Agent
- 개인정보·비밀정보 포함 여부
- 중복, 깨진 텍스트, 페이지 번호와 section metadata
- 샘플 질의에 대한 Retrieval Recall@K

## 6. 평가 재현

오프라인 평가:

```bash
pnpm run eval:offline
```

다섯 방식 반복 비교:

```bash
pnpm run build
pnpm run start
```

별도 터미널:

```bash
node scripts/repeat-benchmark.mjs
```

반복 횟수와 endpoint를 바꿀 수 있습니다.

```bash
BENCHMARK_REPETITIONS=5 BENCHMARK_URL=http://localhost:3000/api/orchestrate node scripts/repeat-benchmark.mjs
```

반복 비교는 `COMMERCIAL_JUDGE_*`가 설정되어야 품질 점수를 반환합니다. 장비·모델·corpus·질의·동시성 조건을 함께 기록하지 않으면 서로 다른 실행 결과를 직접 비교해서는 안 됩니다.

## 7. 테스트와 상태점검

```bash
pnpm run local:check
pnpm run build
node --test tests/orchestrator.test.mjs
```

상태 API:

- `GET /api/health`: Agent별 endpoint와 모델 연결 상태
- `POST /api/orchestrate`: 질의 실행

API 요청 예시:

```bash
curl -X POST http://localhost:3000/api/orchestrate \
  -H "content-type: application/json" \
  -d '{"query":"공공기관 AI 도입의 보안과 예산을 검토해 주세요.","mode":"proposed","commercialJudge":false}'
```

## 보안 체크리스트

- `.env.local`, API key, 인증서, 원본 민감문서는 커밋하지 않습니다.
- 이미 노출된 API key는 저장소 포함 여부와 무관하게 폐기·재발급합니다.
- Ollama endpoint를 인터넷에 직접 공개하지 않습니다.
- Core→Edge 통신에 조직 인증·암호화·접근제어를 적용합니다.
- 운영 로그에 원문 질의와 개인정보를 남길지 정책적으로 결정합니다.
- 상용 블라인드 평가 기능은 비민감 평가 데이터에만 사용합니다.
- 배포 전 dependency 취약점 검사와 조직 보안검토를 수행합니다.

## 주요 명령

| 명령 | 설명 |
|---|---|
| `pnpm run dev` | 개발 서버 |
| `pnpm run build` | 배포 빌드 |
| `pnpm run start` | production 서버 |
| `pnpm run edge:start` | Windows에서 8개 Agent Ollama 실행 |
| `pnpm run edge:stop` | 위 프로세스 종료 |
| `pnpm run local:check` | endpoint·모델 상태 확인 |
| `pnpm run rag:compile` | RAG corpus 재생성 |
| `pnpm run eval:offline` | golden set 오프라인 평가 |
| `node scripts/repeat-benchmark.mjs` | 다섯 방식 반복평가 |

## 라이선스와 데이터

소스코드와 수집 데이터의 배포 권한은 별도로 확인해야 합니다. 공개기관 문서라도 원문 재배포 조건이 다를 수 있으므로, 외부 공개 저장소에는 출처 metadata와 허용된 파생 데이터만 포함하십시오.

