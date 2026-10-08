# MNC FLOW

## 구현 현황과 화면 안내 (2026-09-08)

응답 서비스(`:3100`)와 운영 콘솔(`:3200`)은 별도 프로세스입니다. 서비스는 요청·답변·피드백에 집중하고, `pnpm run monitor`로 실행하는 독립 수집기가 5초마다 지표를 수집해 SQLite에 저장합니다. 콘솔은 지연 추이·P50/P95·오류율·Agent 상태·구현 현황을 제공합니다. 브라우저를 닫아도 콘솔 서버가 실행 중이면 수집을 계속합니다. [모니터링 실행과 구조](docs/MONITORING.md)를 참고하세요.

8개 전문 Agent, Boundary Router v2, Edge RAG와 통합 보고서, 비동기 실행·복구, Privacy Risk v2 및 실행 지표에 더해 응답별 피드백의 서버 저장을 지원합니다. 자세한 범위와 저장소 설정은 [구현 현황](docs/IMPLEMENTATION_STATUS.md)을 참고하세요.

## Privacy Risk v2 평가 보고서

개인정보 위험도는 API가 반환하는 동일한 `privacyRiskVersion: "v2"` breakdown을 보고서와
`/evaluation` 화면에서 사용합니다.

```text
Privacy Risk = 100 × (0.5 × S + 0.3 × A + 0.2 × O)
S = 탐지된 민감정보 중 경계를 넘어 전달된 비율
A = 전체 등록 Agent 중 선택된 Agent 비율
O = 보호 대상 원문 byte 중 경계를 넘어 전달된 원문 byte 비율
```

| v2 보고서 | 실행 범위 | 결과 사용 원칙 |
|---|---:|---|
| `data/evaluation/latest-report-v2.json` | 파일럿 6문항 × 4모드 | `status: measured`일 때만 수치 표시 |
| `data/evaluation/expanded-report-v2.json` | 40문항 × 5모드 (200회) | `status: measured`; 전체 v2 breakdown 실측 |
| `data/evaluation/repeat-benchmark-report-v2.json` | 5질의 × 5모드 × 3회 (75회) | 실행·privacy는 실측, 상용 Judge 미설정으로 품질은 `partial`·`—` |

2026-08-07에 현재 deterministic fallback 빌드로 파일럿 24회(6문항 × 4모드)를 재실행한
Privacy Risk v2 결과입니다. 독립 held-out 평가가 아닌 고정 파일럿입니다.

같은 빌드로 40문항×5모드 200회도 재실행했습니다. 제안 방식은 Macro-F1 96.8%,
객관 품질 54.6점(최고 55.5점 대비 98.4%), 평균 Privacy Risk 9.7점이었고 금지 출력
통과율은 100%였습니다. 반복 75회 역시 완료했지만 상용 Judge 자격증명이 없어 품질 열은
추정하지 않고 `—`로 유지하며 보고서 상태를 `partial`로 기록합니다.

| 모드 | 평균 Risk | S | A | O | 상태 (6건) |
|---|---:|---:|---:|---:|---|
| Centralized | 30.0 | 0.0% | 100.0% | 0.0% | 미탐지 5 · 완전 마스킹 1 · 일부 노출 0 |
| Managed | 10.8 | 0.0% | 35.4% | 0.0% | 미탐지 5 · 완전 마스킹 1 · 일부 노출 0 |
| Parallel | 30.0 | 0.0% | 100.0% | 0.0% | 미탐지 5 · 완전 마스킹 1 · 일부 노출 0 |
| Proposed | 9.0 | 0.0% | 29.2% | 0.0% | 미탐지 5 · 완전 마스킹 1 · 일부 노출 0 |

민감정보 상태는 `민감정보 미탐지`, `탐지 후 완전 마스킹`, `일부 노출`로 구분합니다.
버전이 없는 기존 `latest-report.json`, `expanded-report.json`,
`literature-baseline-report.json`의 수치는 legacy v1 proxy 참고값이며 v2 평균·비교에는 포함하지 않습니다.
아래의 기존 성능 표 역시 v2 재생성 전의 legacy 실험 기록입니다.

공공기관·기업 AX를 위한 **분산형 Multi-Agent RAG 거버넌스 프로토타입**입니다.  
Core가 질의를 분석해 필요한 전문 Agent만 선택하고, 각 Agent는 자신에게 허용된 문서와 독립적인 로컬 LLM endpoint를 사용합니다. 원문을 중앙으로 모으지 않고 최소 결과와 근거 식별자만 통합하는 구조를 실험합니다.

## 현재 구현 범위

- 기술·데이터·보안·법무·정책·재무·조달·운영 등 8개 전문 Agent
- 질의 기반 동적 Agent 선택
- v2 Boundary Router의 단일 Primary + 필수 Reviewer + 적응형 Supporting Agent 실행
- Edge 내부 Required-Concept Gate와 `sanitized`/`metadata-only` 근거 공개 계획
- Agent별 독립 Ollama endpoint와 모델 설정
- Agent ID·문서등급을 서버에서 먼저 검사하는 Edge RAG
- Core에는 요약·근거 ID·계측값만 반환하는 반출 정책
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

실험 원자료 요약은 `data/evaluation/literature-baseline-report.json`에 있습니다.

> 위 수치는 Edge 문서등급 경계를 도입하기 전 저장된 baseline입니다. 현재 런타임은 모든 모드에서 Edge가 원문을 보존하고 안전 요약·근거 참조만 반환하므로, 최신 구조 간 비교값은 동일 조건으로 다시 측정해야 합니다.

### 40문항 고정 정답 평가

별도로 정답 Agent, 필수 개념, 관련 공식 문서군과 금지 출력을 라벨링한 40개 공공·기업 AX 문항을 다섯 방식으로 실행해 총 200개 결과를 평가했습니다.

| 방식 | 객관 품질 (95% CI) | Agent Micro-F1 | 필수개념 Recall | 문서군 Recall@K | 평균 Core 전송량 | 원문 외부 전송 |
|---|---:|---:|---:|---:|---:|---|
| Single Centralized RAG | 58.5 (55.4–62.2) | 46.5 | 14.4 | 51.2 | 50,503B | 있음 |
| All-Agent Aggregation | 81.5 (79.1–83.9) | 46.5 | 75.0 | 51.2 | 6,324B | 없음 |
| MasRouter-inspired | 62.0 (55.9–68.0) | 57.4 | 50.0 | 35.6 | 1,149B | 있음 |
| RemoteRAG-inspired | 49.9 (45.2–54.9) | 57.4 | 14.4 | 37.5 | 4,004B | 있음 |
| 제안 방식 | 70.6 (64.7–76.4) | 64.6 | 62.5 | 42.5 | 2,507B | 없음 |

제안 방식은 정답 기반 최고 품질의 86.6%를 유지했고, MasRouter-inspired보다 +8.6점(95% CI +4.9~+12.8), RemoteRAG-inspired보다 +20.7점(+16.2~+25.5) 높았습니다. 이 평가는 저자 라벨 고정셋이며 독립 전문가 합의평가는 아닙니다. Retrieval Recall@K는 동일 공식 자료의 인접 페이지 검색을 과도하게 실패 처리하지 않도록 출처 문서군 기준으로 계산합니다. 평가셋과 전체 행 단위 결과는 `data/evaluation/ax-golden-set-40.jsonl`과 `data/evaluation/expanded-report.json`에 있습니다.

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

Core와 Edge를 한 PC에서 실행할 수도 있고, Agent별 endpoint를 서로 다른 PC·GPU 서버·KOREN 노드에 배치할 수도 있습니다. Core는 corpus를 직접 import하지 않고 `EdgeAgentClient` 계약만 사용합니다.

### v2 라우팅 실행 순서

1. Core가 DLP 결과, 질의 목적, 역할 메타데이터로 Primary Agent를 정확히 하나 선택합니다.
2. 개인정보·기밀 또는 조달 결합 규칙에 해당하면 보안·법무 또는 조달·재무 Reviewer를 필수로 표시합니다.
3. Primary Edge는 로컬 RAG 원문으로 자신에게 등록된 concept ID의 충족 여부를 계산합니다.
4. Core에는 안전 요약, 근거 ID, concept ID별 충족 상태만 반환합니다. 제한 문서는 계속 `reference-only`입니다.
5. 미충족 concept가 있으면 그 concept의 담당 Supporting Agent만 추가 호출합니다.
6. Edge `deny`는 다른 Agent 호출로 우회하지 않고 사람 검토 상태로 종료합니다.
7. 중앙 통합 모델은 Agent 안전 요약과 근거 ID만 사용해 최종 응답을 생성합니다.

v2의 평가용 중앙 Evidence API는 원문 corpus를 Core에서 직접 읽는 구조였기 때문에 가져오지 않았습니다. 대신 planner를 Edge 내부로 옮겼고, 빈 required-concept 목록은 coverage 100%가 아니라 `unknown + humanReviewRequired`로 처리합니다.

#### 주관기관 선정 기준

주관기관은 특정 단어 하나나 LLM KV cache의 attention 값으로 결정하지 않습니다. 먼저 개인정보·기밀 요청은 보안, 명시적 발주·입찰·조달 요청은 조달을 주관기관으로 고정하는 정책 Gate를 적용합니다. 일반 요청은 요청 전체와 8개 Agent routing profile을 비교하는 `hybrid-profile-v1` 점수로 Primary Agent를 정확히 하나 선택합니다.

| 구성요소 | 가중치 | 의미 |
|---|---:|---|
| 업무 행위·도메인 신호 | 0.36 | 아키텍처, 위탁, 발주, SLA처럼 실제 수행 업무와의 일치 |
| 프로필 의미 유사도 | 0.20 | 요청 전체 토큰·문자 n-gram과 역할·책임·개념 프로필 간 유사도 |
| 키워드·업무 개체 | 0.20 | 예산, 개인정보, 사업자 등 키워드와 구조화된 업무 개체 일치 |
| 근거 준비도 | 0.12 | 담당 required concept와 Agent RAG manifest의 준비 상태 |
| 누락 위험 | 0.08 | 보안·법무 등 필수 역할을 빠뜨렸을 때의 위험 |
| 비용 효율 | 0.04 | 예상 호출·RAG 범위에 따른 상대 비용 |

모든 구성요소와 최종 점수는 0~1로 정규화되어 `routerDecision.primarySelection.rankedCandidates`에 공개됩니다. 함께 반환되는 `confidence`, `top1Top2Margin`, hard-Gate 사유, fallback 사유로 선택을 재현할 수 있습니다. 최고 점수가 0.30 미만이거나 1·2위 차이가 0.025 미만이면 기존 업무 신호 규칙으로 결정적 fallback하며, 업무 신호도 없으면 사람 검토 상태로 남깁니다. `개인정보가 없는`과 같은 부정 범위는 보안·법무의 양성 신호에서 제외합니다.

40개 고정 질의 라우팅 회귀는 다음 명령으로 재현할 수 있습니다.

```bash
node scripts/evaluate-routing-v2.mjs
```

키워드 top-1, 키워드 fan-out, v2 heuristic, 현재 adaptive hybrid의 비교 데이터와 별도 PNG 그래프는 다음 명령으로 재생성합니다.

```bash
node scripts/benchmark-primary-routing.mjs
python scripts/render-primary-routing-charts.py
```

산출물은 `reports/primary-routing-benchmark/`에 JSON, CSV, PNG와 평가 한계 설명을 함께 저장합니다.

### 보안 경계 모델

`EDGE_AGENT_MODE=local` 또는 기본 `auto`의 로컬 fallback은 개발·시연을 위한 **단일 프로세스 논리 경계**입니다. 등급 필터와 반출 검사는 동일하게 실행되지만, 운영체제·네트워크 수준 격리는 제공하지 않습니다. 실제 분산 보안 경계가 필요한 운영 배포에서는 다음을 적용합니다.

- `EDGE_AGENT_MODE=remote`, `EDGE_AGENT_REQUIRE_REMOTE=true`
- 각 Edge 배포의 `EDGE_AGENT_ID`를 하나의 Agent로 고정
- Agent별 HTTPS endpoint와 서로 다른 service token
- Edge endpoint의 Agent ID 고정, 요청·응답 크기 제한, timeout, 감사 ID 기록
- corpus와 Ollama는 Edge 내부에서만 접근하고 Core 네트워크에서는 직접 접근 금지

Edge 응답의 제한 문서는 제목·본문·URL 없이 근거 ID와 등급만 반환됩니다. 공개 문서도 DLP 처리된 짧은 미리보기만 반환됩니다. `local`과 `remote`는 기능 계약은 같지만, 전자에는 물리적 격리가 없다는 차이를 운영 검토에서 반드시 구분해야 합니다.

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

각 Edge 장비에 이 애플리케이션의 Edge API와 Ollama를 함께 배치합니다. Ollama는 Edge 호스트 내부에서만 열고 Core에는 인증된 `/api/edge/agent` HTTPS endpoint만 공개합니다.

Linux 예시:

```bash
ollama pull qwen2.5:0.5b
OLLAMA_HOST=0.0.0.0:11434 OLLAMA_KEEP_ALIVE=15m ollama serve
```

운영환경에서는 위 명령을 직접 노출하지 말고 systemd, 컨테이너 오케스트레이터 또는 내부 AI gateway로 관리하십시오.

Edge별 필수 사항:

- Core의 사설 IP 또는 서비스 계정만 Edge HTTPS API 접근 허용
- 인터넷과 Core에 Ollama `11434` 직접 공개 금지
- Nginx, Envoy 또는 조직 표준 API gateway에서 TLS와 Agent별 인증 적용
- Agent별 모델·문서 index·로그 디렉터리 분리
- 입력 원문과 로그의 보존기간 및 접근권한 설정
- `/api/tags`와 `/api/chat` 상태 모니터링

### Core 장비

Core의 `.env.local`에서 Agent별 Edge API 주소와 credential을 설정합니다.

```dotenv
EDGE_AGENT_MODE=remote
EDGE_AGENT_REQUIRE_REMOTE=true
EDGE_AGENT_TECH_BASE_URL=https://tech-edge.internal.example
EDGE_AGENT_DATA_BASE_URL=https://data-edge.internal.example
EDGE_AGENT_SECURITY_BASE_URL=https://security-edge.internal.example
EDGE_AGENT_LEGAL_BASE_URL=https://legal-edge.internal.example
EDGE_AGENT_POLICY_BASE_URL=https://policy-edge.internal.example
EDGE_AGENT_FINANCE_BASE_URL=https://finance-edge.internal.example
EDGE_AGENT_PROCUREMENT_BASE_URL=https://procurement-edge.internal.example
EDGE_AGENT_OPERATIONS_BASE_URL=https://operations-edge.internal.example
# Secret Manager에서 Agent별 EDGE_AGENT_<AGENT>_TOKEN도 주입
```

설정 확인:

```bash
pnpm run local:check
pnpm run build
pnpm run start
```

운영 기본 포트는 `3000`입니다. 방화벽에서는 사용자→Core 웹 포트와 Core→Edge HTTPS API만 허용합니다. Core→Ollama 및 Core→corpus 경로는 금지합니다. Edge 간 직접 통신은 현재 구현에 필요하지 않습니다.

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
| `EDGE_AGENT_MODE` | `auto`, 개발용 `local`, 운영용 `remote` |
| `EDGE_AGENT_REQUIRE_REMOTE` | 운영에서 단일 프로세스 fallback을 금지 |
| `EDGE_AGENT_ID` | Edge 서버가 담당하는 고정 Agent ID. 운영 Edge에서 필수 |
| `EDGE_AGENT_BASE_URL` | 공통 Edge API HTTPS 주소 |
| `EDGE_AGENT_<AGENT>_BASE_URL` | Agent별 Edge API HTTPS 주소 |
| `EDGE_AGENT_TOKEN` | 공통 service token. 운영에서는 Agent별 token 권장 |
| `EDGE_AGENT_<AGENT>_TOKEN` | Agent별 service token |
| `EDGE_AGENT_TIMEOUT_MS` | Core→Edge timeout |
| `REQUEST_COORDINATOR_SCOPE` | 현재는 `single-process`만 지원. 다른 값은 실행 차단 |
| `REQUEST_COORDINATOR_REPLICA_COUNT` | 중앙 큐 권위를 보장하기 위해 반드시 `1`; 다중 replica는 공유 저장소 구현 전 차단 |
| `COMMERCIAL_JUDGE_BASE_URL` | 선택적 OpenAI 호환 블라인드 평가 API |
| `COMMERCIAL_JUDGE_API_KEY` | 평가 API key. Git 커밋 금지 |
| `COMMERCIAL_JUDGE_MODEL` | 평가 모델 |

상용 평가를 켜면 마스킹된 질의, Edge 생성 요약, 근거 ID·등급만 외부 평가 API로 전송됩니다. 원문 excerpt는 평가 payload에 포함하지 않습니다. 그래도 파생 요약이 조직 정책상 외부 반출 가능한지 확인하고, 민감한 운영 데이터에서는 기본적으로 비활성화하십시오.

## 5. RAG 데이터 갱신

공개 데이터 출처는 `corpus/sources.json`, 실행 corpus는 `data/rag-corpus.json`, 문서 manifest는 `data/manifest.jsonl`에 저장됩니다.

```bash
pnpm run rag:compile
```

원본 수집물과 처리 중간파일은 용량·저작권·개인정보 문제로 Git에서 제외합니다. 다른 환경에서 동일 corpus를 재생성하려면 조직 내부 저장소에서 원본을 안전하게 전달한 뒤 수집·처리 스크립트를 실행하십시오.

새 데이터를 추가할 때 확인할 항목:

- 출처 URL, 문서명, 발행기관, 기준일, 이용조건
- 문서 분류와 접근 가능한 Agent
- 모든 chunk의 명시적 `classification` 값. 누락값을 `public`으로 간주하지 않음
- 개인정보·비밀정보 포함 여부
- 중복, 깨진 텍스트, 페이지 번호와 section metadata
- 샘플 질의에 대한 Retrieval Recall@K

## 6. 평가 재현

오프라인 평가:

```bash
pnpm run eval:offline
pnpm run eval:expanded
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
- 운영 Core에서 `EDGE_AGENT_REQUIRE_REMOTE=true`를 적용하고 corpus/Ollama 직접 경로를 차단합니다.
- Agent별 token 또는 mTLS/JWT audience를 분리하고 endpoint Agent ID를 요청 body만으로 신뢰하지 않습니다.
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
| `pnpm run eval:expanded` | 40문항·다섯 방식 고정 정답 평가 |
| `node scripts/repeat-benchmark.mjs` | 다섯 방식 반복평가 |

## 라이선스와 데이터

소스코드와 수집 데이터의 배포 권한은 별도로 확인해야 합니다. 공개기관 문서라도 원문 재배포 조건이 다를 수 있으므로, 외부 공개 저장소에는 출처 metadata와 허용된 파생 데이터만 포함하십시오.

