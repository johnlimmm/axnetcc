# 로컬 LLM 1차 실측

## Privacy Risk v2 보고 규칙 (MNC-12)

최신 평가에서는 모드별 고정 상수 기반 proxy를 사용하지 않습니다. Orchestrator API가 반환한
`privacyRiskVersion: "v2"`와 아래 S/A/O breakdown을 그대로 저장하고 표시합니다.

```text
Privacy Risk = 100 × (0.5 × S + 0.3 × A + 0.2 × O)
S = sensitiveTransmittedCount / sensitiveDetectedCount
A = selectedAgentCount / totalAgentCount
O = transmittedOriginalBytes / originalBytes
```

분모가 0인 항목은 API 계산 규칙에 따라 비율 0으로 기록합니다. 보고서에는 점수뿐 아니라
각 numerator, denominator, ratio를 함께 남깁니다. 민감정보가 없었던 실행과 탐지 후 완전히
마스킹된 실행을 모두 0점이라고만 표현하지 않고 각각 `민감정보 미탐지`,
`탐지 후 완전 마스킹`으로 구분하며, 하나라도 전달된 경우 `일부 노출`로 표시합니다.

| 파일 | privacyRiskVersion | 현재 공개 규칙 |
|---|---|---|
| `latest-report-v2.json` | `v2` | 실제 재실행 결과만 표시 |
| `expanded-report-v2.json` | `v2` | 40문항×5모드 200회 `measured` |
| `repeat-benchmark-report-v2.json` | `v2` | 75회 실행·privacy 실측, 상용 판정기 미설정 품질은 `partial`·`—` |

현재 v2 파일럿(6문항 × 4모드)의 평균 점수는 Centralized 30.0, Managed 10.8,
Parallel 30.0, Proposed 9.0입니다. 네 모드 모두 S=0%, O=0%였고 A는 각각
100.0%, 35.4%, 100.0%, 29.2%였습니다. 세부 numerator/denominator와 24개 행은
`data/evaluation/latest-report-v2.json`을 단일 기준으로 사용합니다.

확장 보고서의 제안 방식은 Macro-F1 96.8%, 객관 품질 54.6점, 최고 품질 유지율
98.4%, 평균 Privacy Risk 9.7점입니다. 반복 보고서는 75개 행을 모두 저장했으며 상용
판정기가 설정되지 않은 실행에서는 correctness/groundedness/completeness/overall을 `null`로
유지합니다. 이 값들은 deterministic fallback 개발셋 결과이고 독립 전문가 평가는 아닙니다.

미실행 값은 `—`로 두며 추정하지 않습니다. v1 또는 버전 없는 행/보고서가 섞이면 집계를
중단합니다. 이 문서 아래쪽의 기존 고정 proxy 설명과 수치는 실험 이력일 뿐 v2 결과가 아닙니다.

측정일: 2026-07-30  
실행 환경: Windows, Ollama 0.32.5, CPU 추론  
질의: `3년 예산과 총소유비용을 산정해 주세요.`

## 모델 선택 결과

| 모델 | 결과 |
| --- | --- |
| qwen3:4b | 256토큰·66.97초 동안 reasoning만 생성하고 최종 답변 없음 |
| qwen2.5:3b | 비사고형 한국어 최종 답변 정상 생성 |

## qwen2.5:3b 측정

| 단계 | TTFT | TPOT | 전체 지연 | 입력 토큰 | 출력 토큰 | TPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 최초 Agent RAG | 57,597ms | 208.1ms | 76,772ms | 947 | 96 | 5.01 |
| 문맥 압축 후 | 21,844ms | 238.0ms | 39,000ms | 542 | 80 | 4.67 |
| 모델·KV 캐시 warm-run | 1,246ms | 163.3ms | 19,547ms | 542 | 120 | 6.56 |

RAG 근거 수는 2개로 유지하고 각 근거의 LLM 전달 길이를 600자에서 250자로
줄였다. 입력 토큰은 42.8%, TTFT는 62.1%, 전체 지연은 49.2% 감소했다.
검색 원문과 감사용 청크는 축약하지 않고, LLM에 전달하는 최소 문맥만 압축했다.

이 수치는 단일 실행 결과이므로 연구 결과에는 반복 실행 P50·P95와 신뢰구간을
추가해야 한다.
## 지표 정의

- TTFT: 요청 전송부터 첫 출력 토큰 수신까지의 시간
- TPOT: Ollama의 실제 생성시간(`eval_duration`)을 출력 토큰 수(`eval_count`)로 나눈 값
- E2E latency: 요청 시작부터 검증·통합 완료까지의 전체 시간
- 성공률: timeout이나 deterministic fallback 없이 끝난 Agent 비율

화면의 방식별 비교표는 같은 브라우저 세션에서 실제 실행한 결과만 `실측`으로
표시한다. 실행하지 않은 방식의 TTFT, TPOT, E2E 값은 추정하지 않고 `—`로 남긴다.

## 연구 평가에 추가할 항목

TTFT와 TPOT만으로는 제안 방식의 우수성을 입증할 수 없다. 동일 질의 세트와 동일
하드웨어에서 각 방식을 반복 실행하고 다음을 함께 보고해야 한다.

- 품질: 정답 정확도 또는 전문가 rubric 점수, 근거 precision/recall, citation faithfulness
- 효율: TTFT/TPOT/E2E의 p50·p95, 총 입력·출력 토큰, Core–Edge 전송량
- 라우팅: 필요한 Agent 선택 precision/recall/F1, 불필요 Agent 호출 감소율
- 안정성: 성공률, timeout률, fallback률
- 거버넌스: 민감정보 노출률, 근거 연결률, 감사로그 완전성
- 실험 통제: cold/warm 실행 분리, 동일 seed·출력 길이·질의 순서, 최소 30회 반복

## 데이터 보호 비교지표

- 원문 Edge 이탈: 원문 질의와 검색 근거가 중앙 처리영역으로 이동하는지 여부
- Core 전송량: 방식 실행 중 Core로 전달된 요청·근거·요약 payload 바이트
- 데이터 수신 범위: 질의 또는 최소 질의를 받은 처리주체 수
- 데이터 최소화율: 중앙집중형 원문 전송량 대비 감소 비율
- 프라이버시 위험점수: 원문 이동 75점, 처리주체 범위, 탐지 민감필드를 결합한
  0~100 비교용 proxy

프라이버시 위험점수는 구조 비교를 위한 설명 가능한 합성지표이며 실제 개인정보
침해 확률이나 법적 안전성을 뜻하지 않는다. 논문 결과에는 구성요소별 원시값도 함께
제시해야 한다.

## 품질지표

- 질의 관련성: 질의 핵심어가 Agent 답변에 반영된 비율
- 근거 내용 일치: 답변 핵심어가 검색 근거 내용으로 뒷받침되는 비율
- 인용 유효성: 답변이 명시한 근거 ID 중 실제 검색 ID와 일치하는 비율
- 인용 커버리지: 선택 Agent 중 하나 이상의 유효한 근거 ID를 표기한 Agent 비율
- 전문영역 충족도: 질의에서 요구된 필수 전문영역이 선택·검토된 비율
- 답변 완전성: 최소 답변 길이와 검색 근거를 모두 충족한 Agent 비율
- 종합 품질점수: 관련성 30%, 근거 내용 일치 30%, 영역 20%, 완전성 15%,
  인용 유효성 5% 가중합

자동 품질지표는 재현 가능한 1차 평가다. 전문가 rubric, 정답셋 정확도, RAGAS 계열
평가나 독립 LLM judge를 최종 실험에서 추가한다. Judge 모델은 평가 대상 모델과
분리하고 사람 평가와 상관관계를 보고한다.

## 상용 플랫폼 기준선

`managed` 방식은 중앙 Supervisor가 질의를 분류하고 선택된 전문 Agent의 결과를 다시
통합하는 관리형 상용 Agent 플랫폼 패턴을 모사한다. 실제 외부 상용 API의 성능이나
보안을 대표하는 값은 아니며, 동일 로컬 모델·질의·근거에서 실행구조만 비교하기 위한
통제 기준선이다.

공공기관·기업 AX 특화 확장 축은 다음 네 가지다.

- Public Policy Pack: 개인정보, 보안, 조달, 영향평가 규칙
- Human Accountability: 최종 승인자와 담당부서 연결
- Data Sovereignty: 조직별 원문·RAG의 Edge 잔류
- AX Evidence: 품질·보호·성능·비용의 반복 실험과 감사 로그
