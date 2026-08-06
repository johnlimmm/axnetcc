# MNC-Flow 고도화 평가 프로토콜

## 연구 질문

- RQ1: 학습 데이터가 적은 신규 조직에서 제안 router가 학습형·비학습형 router보다 높은 expert-selection F1을 보이는가?
- RQ2: 최고 품질 방식 대비 허용 가능한 품질 저하 범위 안에서 cross-boundary bytes와 민감정보 노출을 줄이는가?
- RQ3: 미관측 조직·업무영역·문서 corpus에서도 효과가 유지되는가?
- RQ4: 지연·장애·timeout이 있는 실제 분산 환경에서도 deadline 내 품질이 유지되는가?

## 사전 등록할 주가설

1. 제안 방식의 expert-selection Macro-F1은 최강 비학습 baseline보다 높다.
2. 제안 방식의 종합 품질은 All-Agent 대비 비열등하다. 비열등성 한계는 절대 5점으로 고정한다.
3. 비열등성이 성립한 조건에서 cross-boundary bytes는 All-Agent 대비 40% 이상 감소한다.
4. confidential 질의에서 raw document와 직접 식별정보의 경계 외부 유출률은 0%다.

가설, 제외 기준, 가중치, threshold, random seed는 최종 test set을 실행하기 전에 고정한다.

## 데이터 구성

- 최소 240개 고유 질의
- 조직 시나리오 3개 이상: 중앙행정기관, 지방자치단체, 일반 기업
- 8개 전문 역할별 단독·복합 질의를 균형 배치
- basic, advanced, adversarial을 각각 최소 25% 포함
- 개인정보, 내부기밀, 공개정보의 데이터 등급을 모두 포함
- 동일 의미를 표현만 바꾼 문항은 `group_id`로 묶어 같은 split에 배치
- 학습 60%, 검증 20%, 최종 test 20%
- 외부 타당성 test는 조직 하나 또는 corpus 하나를 통째로 제외한 leave-one-organization-out 방식으로 구성

기존 40문항은 개발·파일럿 데이터로만 사용하며 최종 확증 test에는 재사용하지 않는다.

## 독립 라벨링

- 전문영역별 2인 이상이 서로의 라벨을 보지 않고 독립 라벨링
- 불일치 문항은 제3 adjudicator가 근거를 확인해 확정
- agent label은 Krippendorff's alpha 또는 역할별 Cohen's kappa를 보고
- 필요한 근거 문서는 문서 ID뿐 아니라 근거 span과 판정 이유를 저장
- 라벨러가 제안 방식의 실제 선택 결과를 보지 못하도록 blind 처리

### 상용 LLM 보조 라벨링

초기 240문항은 OpenAI mini 모델 두 종류를 독립 라벨러로 사용할 수 있다. 각 호출에는 전체 인터넷 지식이
아니라 해당 문항에 연결된 수집 corpus chunk, 출처 URL, 발행일, 문서 ID만 제공한다. 두 모델은 서로의
출력을 볼 수 없으며 역할 집합이 다르거나 근거 ID·직접 인용이 유효하지 않을 때만 제3 adjudicator 모델이
조정한다.

이 결과는 `LLM-generated gold label`이 아니라 `LLM-assisted provisional annotation`으로 표기한다.
상용 LLM은 법률가·보안전문가 등 실제 자격을 가진 사람이 아니므로 “전문가 2인 검증”이라고 표현하지 않는다.
최종 test 승격 전에는 무작위 표본과 모든 불일치·저신뢰 문항을 사람이 검토하고, 모델 간 일치도와
사람–모델 일치도를 함께 보고한다. 평가 대상 시스템과 자동 라벨러가 같은 모델 계열이면 자기선호 편향이
발생할 수 있으므로 최종 답변 품질의 유일한 judge로 사용하지 않는다.

필수 필드:

```json
{
  "id": "ORG1-001",
  "group_id": "ORG1-G001",
  "organization": "central-government",
  "domain": "privacy-impact-assessment",
  "difficulty": "advanced",
  "data_class": "confidential",
  "query": "...",
  "expected_agents": ["security", "legal", "policy"],
  "required_concepts": ["..."],
  "evidence": [
    {"document_id": "...", "span": "...", "supports": "..."}
  ],
  "forbidden_output": ["..."],
  "annotator_ids": ["A01", "A02"],
  "adjudication_status": "agreed"
}
```

## Baseline 계층

### Expert-selection baseline

- random, static department mapping
- semantic top-k
- calibrated threshold multilabel router
- learned multilabel classifier
- LLM-as-router
- cost-aware subset selection
- oracle expert set
- 제안 boundary-constrained router

### 연구 기반 구조 adapter

- MasRouter: agent 수·role allocation·collaboration cascade
- RouteLLM: preference 기반 router를 role selection으로 대응
- IRT-Router: role ability와 query difficulty를 이용한 선택

Adapter 결과는 원 논문의 benchmark 결과로 표현하지 않는다. 공식 구현의 완전 재현 결과와 구조 adapter 결과를 표에서 분리한다.

### End-to-end architecture baseline

- centralized RAG
- All-Agent parallel
- local-only RAG
- remote retrieval
- proposed Edge-Agent/Core

모델 선택 router와 expert 선택 router를 같은 의미로 해석하지 않는다.

## 평가지표

### Router 품질

- Micro/Macro precision, recall, F1
- exact set match
- hamming loss
- 역할별 recall 및 worst-role recall
- adversarial subset recall

### 답변 및 RAG 품질

- 정답이 있는 문항: exact match 또는 task-specific score
- 근거 검색: Recall@K, MRR, nDCG@K
- 인용: claim 단위 entailment와 citation correctness
- 금칙 정보: exact leakage rate와 entity-level leakage recall

LLM judge를 사용할 경우 모델명·prompt·temperature를 고정하고, 최소 20% 표본에서 사람 평가와 상관 및 일치도를 함께 보고한다.

### 시스템 및 보호

- p50/p95/p99 TTFT, TPOT, end-to-end latency
- time-to-first-valid-answer
- timeout rate, quality under deadline
- agent fan-out, GPU-seconds/request
- raw/retrieved/summary/metadata별 cross-boundary bytes
- unauthorized document access rate
- sensitive-entity leakage rate
- quality per disclosed KB

## 통계 분석

- 분석 단위는 실행 횟수가 아니라 고유 질의
- F1 차이는 질의 단위 paired permutation test와 cluster bootstrap CI
- exact match는 exact McNemar test
- 여러 baseline 비교에는 Holm 보정
- 품질 비열등성은 one-sided paired test와 사전 고정한 5점 margin 사용
- 품질–bytes–latency는 단일 임의 가중합만 제시하지 않고 Pareto front를 함께 보고
- 평균뿐 아니라 조직·난이도·데이터 등급별 결과와 worst-group 결과를 보고

## 현재 결과의 올바른 위치

현재 40문항 결과는 feasibility 및 effect-size 추정용이다. 학습형 adapter 대비 우위는 관찰됐지만,
static·top-k·threshold 대비 우위는 Holm 보정 후 유의하지 않다. 따라서 현재 논문의 강한 주장은
"모든 router보다 정확하다"가 아니라 다음과 같다.

> 학습 데이터가 적은 공공·기업 AX 파일럿에서 제안 방식은 경쟁 가능한 라우팅 품질을 보이며,
> 품질–통신량 Pareto 전선에 위치하고 원문을 경계 밖으로 보내지 않는다.

확증 연구에서는 240개 이상의 독립·외부 라벨 질의로 정확도 우위 또는 품질 비열등성과
데이터 노출 절감의 결합 가설을 검증한다.
