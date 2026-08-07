import type { AgentId, Classification } from "./agent-registry";
import { sanitizeSensitiveText } from "./data-loss-prevention";
import {
  validateEdgeAgentRequest,
  validateEdgeAgentResponse,
  type EdgeAgentRequest,
  type EdgeAgentResponse,
} from "./edge-agent-contract";

const MAX_EDGE_RESPONSE_BYTES = 256 * 1024;
const EXPECTED_POLICY_VERSION = "edge-rag-v1";
const classificationRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" ||
    hostname === "::1" || hostname === "[::1]";
}

function environmentKey(agentId: AgentId, suffix: "BASE_URL" | "TOKEN") {
  return `EDGE_AGENT_${agentId.toUpperCase()}_${suffix}`;
}

function resolveRemote(agentId: AgentId) {
  const baseUrl = process.env[environmentKey(agentId, "BASE_URL")] ?? process.env.EDGE_AGENT_BASE_URL ?? "";
  const agentToken = process.env[environmentKey(agentId, "TOKEN")] ?? "";
  const token = process.env.NODE_ENV === "production"
    ? agentToken
    : agentToken || process.env.EDGE_AGENT_TOKEN || "";
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

function edgeEndpoint(baseUrl: string) {
  const url = new URL(baseUrl);
  const loopback = isLoopback(url.hostname);
  const developmentLoopback = url.protocol === "http:" && loopback && process.env.NODE_ENV !== "production";
  if (url.protocol !== "https:" && !developmentLoopback) {
    throw new Error("Edge Agent 연결은 HTTPS가 필수이며 HTTP는 loopback 개발 환경에서만 허용됩니다.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Edge Agent endpoint must not contain credentials, query parameters, or fragments");
  }
  if (!url.pathname.endsWith("/api/edge/agent")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/edge/agent`;
  }
  return url.toString();
}

function remoteTimeoutMs(deadlineMs: number) {
  const configured = Number(process.env.EDGE_AGENT_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(configured) || configured < 100) {
    throw new Error("EDGE_AGENT_TIMEOUT_MS must be a finite number of at least 100ms");
  }
  return Math.min(deadlineMs, Math.floor(configured));
}

async function readLimitedResponse(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_EDGE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Edge Agent response size limit exceeded");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function assertNoSensitiveEgress(response: EdgeAgentResponse) {
  const fields = [response.answer.text];
  for (const evidence of response.evidence) {
    if (evidence.classification === "public") {
      fields.push(evidence.title, evidence.section, evidence.excerpt);
      if (evidence.sourceUrl) fields.push(evidence.sourceUrl);
    }
  }
  if (fields.some((field) => sanitizeSensitiveText(field).filteredFields.length > 0)) {
    throw new Error("Remote Edge Agent response failed egress DLP validation");
  }
}

async function executeRemote(
  request: EdgeAgentRequest,
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
) {
  const endpoint = edgeEndpoint(baseUrl);
  if (!token) {
    throw new Error("Remote Edge Agent authentication token is required");
  }
  if (process.env.NODE_ENV === "production" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("TLS certificate verification must not be disabled for remote Edge Agents");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Edge Agent timeout", "TimeoutError")),
    remoteTimeoutMs(request.limits.deadlineMs),
  );
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-edge-agent-id": request.agentId,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Edge Agent HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_EDGE_RESPONSE_BYTES) throw new Error("Edge Agent response size limit exceeded");
    const body = await readLimitedResponse(response);
    let parsed: EdgeAgentResponse;
    try {
      parsed = validateEdgeAgentResponse(JSON.parse(body));
    } catch {
      throw new Error("Edge Agent returned an invalid response");
    }
    if (parsed.agentId !== request.agentId || parsed.requestId !== request.requestId) {
      throw new Error("Edge Agent response identity mismatch");
    }
    if (parsed.boundary.transport !== "http") {
      throw new Error("Remote Edge Agent response has an invalid transport marker");
    }
    if (parsed.audit.policyVersion !== EXPECTED_POLICY_VERSION) {
      throw new Error("Remote Edge Agent response has an unsupported policy version");
    }
    if (request.requestedMaxClassification) {
      const ceiling = classificationRank[request.requestedMaxClassification];
      if (parsed.policy.effectiveClasses.some((item) => classificationRank[item] > ceiling)) {
        throw new Error("Remote Edge Agent exceeded the requested classification ceiling");
      }
    }
    assertNoSensitiveEgress(parsed);
    const actualBytes = new TextEncoder().encode(body).length;
    const evidenceBytes = new TextEncoder().encode(JSON.stringify(parsed.evidence)).length;
    if (parsed.boundary.returnedBytes !== actualBytes ||
        parsed.metrics.egressBytes !== actualBytes ||
        parsed.boundary.evidencePayloadBytes !== evidenceBytes) {
      throw new Error("Remote Edge Agent response boundary metrics are inconsistent");
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/** Core가 사용하는 유일한 RAG/Agent 진입점. corpus 모듈을 정적으로 import하지 않는다. */
export async function executeEdgeAgent(
  untrustedRequest: unknown,
  signal?: AbortSignal,
): Promise<EdgeAgentResponse> {
  const validatedRequest = validateEdgeAgentRequest(untrustedRequest);
  const request: EdgeAgentRequest = {
    ...validatedRequest,
    minimalQuery: sanitizeSensitiveText(validatedRequest.minimalQuery).sanitized,
  };
  const mode = (process.env.EDGE_AGENT_MODE ?? "auto").trim().toLowerCase();
  const remote = resolveRemote(request.agentId);
  if (mode === "remote" || (mode === "auto" && remote.baseUrl)) {
    if (!remote.baseUrl) throw new Error(`${request.agentId} Edge Agent endpoint가 설정되지 않았습니다.`);
    return executeRemote(request, remote.baseUrl, remote.token, signal);
  }
  if (mode !== "auto" && mode !== "local") {
    throw new Error(`지원하지 않는 EDGE_AGENT_MODE: ${mode}`);
  }
  if (process.env.NODE_ENV === "production" && process.env.EDGE_AGENT_REQUIRE_REMOTE === "true") {
    throw new Error("운영 환경에서는 remote Edge Agent가 필수입니다.");
  }
  // 단일 프로세스 프로토타입용 논리 경계다. 운영에서는 EDGE_AGENT_MODE=remote를 사용한다.
  const { executeEdgeAgentLocally } = await import("./edge-agent-service");
  return executeEdgeAgentLocally(request, signal);
}
