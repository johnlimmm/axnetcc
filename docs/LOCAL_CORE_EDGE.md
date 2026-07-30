# 로컬 Core–Edge 실행 구조

현재 MVP는 Core, 8개 전문 Agent, RAG 인덱스, Ollama를 한 PC에서 실행한다.
네트워크 배치 전에도 서비스 경계를 유지하기 위해 Agent마다 LLM endpoint와 model을
독립 설정한다.

## 현재 배치

- Core/UI/API: `http://127.0.0.1:3000`
- 기술 Agent Ollama: `http://127.0.0.1:11441`
- 데이터 Agent Ollama: `http://127.0.0.1:11442`
- 보안 Agent Ollama: `http://127.0.0.1:11443`
- 법무 Agent Ollama: `http://127.0.0.1:11444`
- 정책 Agent Ollama: `http://127.0.0.1:11445`
- 재무 Agent Ollama: `http://127.0.0.1:11446`
- 조달 Agent Ollama: `http://127.0.0.1:11447`
- 운영 Agent Ollama: `http://127.0.0.1:11448`
- 독립 Edge 모델: `qwen2.5:0.5b`
- 품질 비교용 단일 모델: `qwen2.5:3b` (`11434`)
- Agent: tech, data, security, legal, policy, finance, procurement, operations
- RAG: Agent별 허용 corpus만 검색

각 Agent는 독립 Ollama 프로세스, 포트, 모델 세션, system prompt, 책임 범위,
검색 권한과 추론 지표를 가진다. 따라서 전체 Agent 방식은 같은 Ollama 큐를 공유하지
않고 실제 동시 요청을 실행할 수 있다.

현재 PC의 가용 메모리를 고려해 8개 독립 인스턴스에는 약 397MB 크기의 0.5B 모델을
사용한다. 방식 비교 실험에서는 세 방식 모두 동일한 0.5B 모델을 사용해야 한다.
3B 결과와 0.5B 결과를 같은 표에서 직접 비교하지 않는다.

## 실행

```powershell
npm run edge:start
npm run local:check
npm run dev
```

종료할 때는 `npm run edge:stop`을 실행한다. Edge 로그와 PID 상태는 Git에서 제외된
`.local-edge` 폴더에 저장된다.

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
