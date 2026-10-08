# Edge/Core 분리 실행

MNC-6의 운영 경계는 Core와 각 Agent를 서로 다른 프로세스 또는 호스트로 실행하는 구성입니다. Core가 받는 응답은 `summary`, `evidenceRefs`, `metrics`, `policy`, `audit` 메타데이터로 제한되며, 공개 문서를 포함한 모든 문서의 제목·절·본문·URL은 Edge 프로세스에 남습니다.

## 로컬 2-프로세스 확인

아래 값은 예시입니다. 토큰을 파일이나 Git에 저장하지 말고 각 터미널의 환경 변수로만 설정합니다.

Edge 터미널:

```powershell
$env:PORT = "3002"
$env:EDGE_AGENT_ID = "security"
$env:EDGE_AGENT_MODE = "local"
$env:EDGE_AGENT_SECURITY_TOKEN = "<locally-generated-token>"
npm run dev
```

Core 터미널:

```powershell
$env:PORT = "3001"
$env:EDGE_AGENT_MODE = "remote"
$env:EDGE_AGENT_SECURITY_BASE_URL = "http://127.0.0.1:3002"
$env:EDGE_AGENT_SECURITY_TOKEN = "<same-locally-generated-token>"
npm run dev
```

개발 환경에서는 loopback HTTP만 허용됩니다. 운영 환경은 Agent별 HTTPS endpoint, 서로 다른 token, `EDGE_AGENT_REQUIRE_REMOTE=true`를 사용해야 합니다. 각 Agent는 `EDGE_AGENT_ID` 하나에만 결합되므로 실제 구성에서는 Agent별 Edge 프로세스를 별도로 실행합니다.

## 경계 확인 항목

- Edge 프로세스만 RAG corpus와 원문을 읽습니다.
- Core는 `lib/edge-agent-client.ts`의 strict DTO validator를 통과한 응답만 받습니다.
- `evidenceRefs[]`는 `referenceId`, `classification`, `disclosure=reference-only`만 포함합니다.
- 알 수 없는 top-level 또는 nested key는 전체 응답을 거부합니다.
- Agent 권한, policy effective class, summary/evidence classification이 일치하지 않으면 fail-closed 처리합니다.
- 원격 응답 byte 수와 audit policy version이 일치하지 않으면 Core가 응답을 폐기합니다.

계약 회귀시험:

```powershell
node --experimental-strip-types --test tests/edge-core-contract.test.mjs
```
