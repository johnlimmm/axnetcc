# KOREN 배치 전 로컬 MVP

## 완료 조건

1. 단일 요청으로 필요한 Agent만 선택된다.
2. Agent마다 독립 코퍼스에서 근거가 검색된다.
3. 요청과 응답의 민감정보가 필터링된다.
4. 결과에 근거 ID와 검토 주체가 남는다.
5. 누락·충돌·근거 부족을 검증한다.
6. 중앙집중형, 병렬형, 제안형을 같은 평가셋으로 비교한다.
7. 모든 실행 결과를 재현 가능한 JSON으로 저장할 수 있다.

## 현재 구성

```text
app/
  api/orchestrate/route.ts   HTTP 오케스트레이션 API
lib/
  knowledge.ts               Agent 프로필과 실증 코퍼스
  orchestrator.ts            선택·검색·필터·검증·추적
data/
  manifest.jsonl             데이터 출처·갱신·라이선스
  evaluation/golden-set.jsonl 평가 질문과 정답 기준
docs/
  DATASET_STRATEGY.md        데이터 수집·청킹·평가 정책
```

## 다음 순서

1. Golden Set 자동 평가 러너
2. Markdown/PDF/HWP 수집·청킹 파이프라인
3. SQLite 또는 Qdrant 기반 Agent별 인덱스
4. 실제 LLM 어댑터와 Mock 어댑터 분리
5. 요청자 역할 기반 정책 엔진
6. 실행 로그와 비교 실험 결과 저장
7. Docker Compose로 서비스 분리
8. 마지막에 Core/Edge 주소만 KOREN 배치값으로 교체

