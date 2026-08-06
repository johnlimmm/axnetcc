# AXNetCC v2

AXNetCC v2는 공공기관과 기업 AX를 위한 분산형 Multi-Agent RAG 및 Security-Aware Evidence Acquisition 연구 구현입니다. 부서별 고유 Agent와 고정 endpoint를 유지하면서, 근거를 `raw`, `sanitized`, `local-summary`, `metadata-only` 중 어떤 형태로 부서 경계 너머 전달할지 정책과 네트워크 상태에 따라 결정합니다.

원문을 중앙으로 모으지 않고 각 부서의 로컬 RAG와 LLM endpoint에서 처리하며, Core는 최소 결과와 근거 handle만 통합합니다. 기존 AXNetCC 웹 UI, 평가 화면, 오케스트레이터 API와 실행 모드를 유지하면서 SAEA 기능을 하위 호환 방식으로 추가했습니다.

## 주요 기능

- 기술·데이터·정보보호·법무·정책·재무·조달·운영 8개 부서 Agent
- Agent별 고정 Ollama-compatible endpoint와 로컬 corpus
- PGRF 및 Role-Concept Router 기반 동적 Agent 선택
- 민감도, 부서 경계, 예상 coverage, 네트워크 상태를 결합한 evidence mode 선택
- Evidence Gateway와 application-layer network proxy를 통한 실제 HTTP 실험
- `raw`, `sanitized`, `local-summary`, `metadata-only` 변환 및 hard policy enforcement
- Single Centralized RAG, All-Agent, static/top-k/threshold/learned/cost-aware 및 연구기법 adapter 비교
- query-cluster bootstrap, paired permutation, Holm 보정, ablation 및 raw trace 보존
- Qwen 2.5, Llama 3.1, Gemma 3, OpenAI blind-role judge 교차 검증
- 기존 실행 화면(`/`), 평가 화면(`/evaluation`), 서비스 설명(`/about`)

## 실행

요구사항은 Node.js 22.13 이상과 pnpm입니다.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

로컬 Agent stack 점검과 실행:

```bash
pnpm local:check
pnpm edge:start
```

환경변수의 실제 API key나 credential은 저장소에 포함하지 않습니다. `.env.local`은 Git에서 제외됩니다.

## 검증

```bash
pnpm lint
pnpm test
pnpm build
```

현재 검증 결과는 lint 오류 0, test 13/13 통과, production build 통과입니다. lint에는 기존 스타일 및 미사용 변수 경고 3개가 남아 있습니다.

## Security-Aware Evidence Acquisition

실험 실행과 분석:

```bash
pnpm eval:security-evidence -- --full --run-id=<run-id>
pnpm eval:security-evidence:analyze -- data/evaluation/security-evidence/<run-id>
pnpm eval:security-evidence:validate -- data/evaluation/security-evidence/<run-id>
```

논문 패키지 생성:

```bash
pnpm paper:security-evidence -- \
  data/evaluation/security-evidence/paper-full-v4-20260806 \
  data/evaluation/security-evidence/paper-validation-40-20260806 \
  data/evaluation/multi-llm-annotation/paper-multillm-aligned-40-20260806 \
  data/evaluation/openai-blind-role/paper-openai-blind-40-20260806
```

최종 main run은 24,624 jobs와 49,248 HTTP traces, 40-query validation은 5,040 jobs와 12,222 traces로 구성됩니다. 두 run 모두 validator를 통과했고 최종 transport failure는 0입니다.

대표 결과:

| 평가 | 방식 | Evidence completion | Policy violation | Raw boundary bytes |
| --- | --- | ---: | ---: | ---: |
| Main 6-query | AXNetCC-SAEA | 0.860 | 0.000 | 115.329 |
| Main 6-query | Fixed sanitized | 0.859 | 0.000 | 0.000 |
| Main 6-query | Raw central | 0.997 | 0.923 | 3357.199 |
| Validation 40-query | AXNetCC-SAEA | 0.723 | 0.000 | 276.167 |
| Validation 40-query | Fixed sanitized | 0.739 | 0.000 | 0.000 |
| Validation 40-query | Raw central | 0.759 | 0.675 | 3502.363 |

상세 표, bootstrap, ablation, 해시 manifest는 `paper/saea`와 각 run 디렉터리에 있습니다. 대형 최종 raw trace와 request-level CSV는 Git LFS로 관리합니다.

## 다중 LLM role-label 검증

40개 semantic-family 후보를 동일한 순서와 입력 SHA-256으로 Qwen, Llama, Gemma 및 OpenAI judge에 blind 제시했습니다.

- 로컬 3모델 평균 pairwise Jaccard: 0.267
- 로컬 3모델 macro Fleiss' kappa: 0.041
- OpenAI와 author-provisional label micro-F1: 0.815
- OpenAI와 로컬 consensus micro-F1: 0.586
- 4모델 macro Fleiss' kappa: 0.123

네 모델 계열의 차이를 함께 측정해 hard exact-match뿐 아니라 핵심 역할·지원 역할·soft label을 결합하는 차세대 routing 평가 기반을 확보했습니다.

## 주요 문서

- `docs/SECURITY_EVIDENCE_IMPLEMENTATION_AUDIT.md`: 구현 전 자산 감사 및 변경 계획
- `docs/SECURITY_AWARE_EVIDENCE_ACQUISITION.md`: SAEA 설계와 API
- `docs/SECURITY_EVIDENCE_EXPERIMENT_METHOD.md`: 비교실험과 통계 방법
- `docs/MULTI_LLM_JUDGE_VALIDATION.md`: 다중 LLM blind judge 검증
- `docs/SECURITY_EVIDENCE_CLAIM_BOUNDARIES.md`: 주장 가능 범위와 한계
- `paper/saea/PAPER_RESULTS.md`: 논문용 최종 결과
- `paper/saea/ARTIFACT_MANIFEST.json`: 논문 자산 SHA-256 manifest

## 검증 환경과 확장 계획

현재 결과는 실제 HTTP Evidence Gateway와 application-layer network proxy에서 측정했습니다. 같은 endpoint·manifest·trace 구조를 유지한 채 물리 KOREN 망, packet-level 계측, 실제 기관 보안 프로파일, 독립 전문가 평가로 확장할 수 있도록 설계했습니다.

## 데이터 및 보안

- 기존 raw corpus와 평가셋은 수정하지 않습니다.
- 부족한 security 및 role-concept 필드는 derived manifest로 추가합니다.
- API key, `.env.local`, 로컬 모델, raw/processed corpus와 build cache는 저장소에서 제외합니다.
- OpenAI blind judge에는 synthetic/public candidate query와 role 목록만 전달했으며 raw corpus, security metadata, 기존 정답 label은 전달하지 않았습니다.
