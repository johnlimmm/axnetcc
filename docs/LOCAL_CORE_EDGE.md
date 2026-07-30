# 로컬 Core–Edge 실행 구조

현재 MVP는 Core, 8개 전문 Agent, RAG 인덱스, Ollama를 한 PC에서 실행한다.
네트워크 배치 전에도 서비스 경계를 유지하기 위해 Agent마다 LLM endpoint와 model을
독립 설정한다.

## 현재 배치

- Core/UI/API: `http://127.0.0.1:3000`
- Ollama: `http://127.0.0.1:11434`
- 기본 모델: `qwen2.5:3b`
- Agent: tech, data, security, legal, policy, finance, procurement, operations
- RAG: Agent별 허용 corpus만 검색

각 Agent는 독립 system prompt, 책임 범위, 검색 권한, 추론 지표를 가진다. 현재는
GPU/메모리 중복 사용을 피하려고 같은 Ollama daemon과 모델 가중치를 공유한다.
동일 endpoint를 공유하는 Agent 요청은 큐에서 순차 처리되며, 서로 다른 endpoint로
분리하면 자동으로 병렬 처리된다.

## 물리 Edge로 이전

`.env.local`의 Agent별 `BASE_URL`과 `MODEL`만 변경한다.

```dotenv
LOCAL_LLM_SECURITY_BASE_URL=http://edge-security:11434
LOCAL_LLM_SECURITY_MODEL=qwen2.5:3b
LOCAL_LLM_LEGAL_BASE_URL=http://edge-legal:11434
LOCAL_LLM_LEGAL_MODEL=qwen2.5:3b
```

Core와 UI 코드는 바꾸지 않고 주소 설정만으로 분리할 수 있다. Ollama API를 공용
인터넷에 직접 노출하지 말고 KOREN 사설망, VPN 또는 인증 gateway 안에서 연결한다.
