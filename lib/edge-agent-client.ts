import { resolveEdgeReplicas, type EdgeReplica } from "./edge-replicas";
import { scheduleEdgeAttempt, remoteAgentBudget } from "./execution-scheduler";
import { EndpointSchedulerError } from "./endpoint-scheduler";
import { recordEdgeAttempt, type EdgeAttempt } from "./distributed-metrics";
import type { Classification } from "./agent-registry";
import { sanitizeSensitiveText } from "./data-loss-prevention";
import {
  projectEdgeAgentResponseForCore,
  validateCoreEdgeAgentResponse,
  type CoreEdgeAgentResponse,
} from "./edge-core-contract";
import {
  validateEdgeAgentRequest,
  type EdgeAgentRequest,
} from "./edge-agent-contract";

const MAX_EDGE_RESPONSE_BYTES = 256 * 1024;
const EXPECTED_POLICY_VERSION = "edge-rag-v1";
const classificationRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

class EdgeAttemptFailure extends Error {
  readonly reasonCode: string;
  readonly retryable: boolean;
  constructor(reasonCode: string, retryable = false) {
    super(reasonCode); this.name = "EdgeAttemptFailure";
    this.reasonCode = reasonCode; this.retryable = retryable;
  }
}
function failure(error: unknown): EdgeAttemptFailure {
  if (error instanceof EdgeAttemptFailure) return error;
  if (error instanceof EndpointSchedulerError) {
    if (error.code === "TASK_CANCELLED") return new EdgeAttemptFailure("cancelled");
    if (error.code === "TASK_DEADLINE_EXCEEDED") return new EdgeAttemptFailure("attempt-timeout", true);
    return failure(error.cause);
  }
  if (error && typeof error === "object") {
    const code = "code" in error ? error.code : undefined;
    if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(String(code))) {
      return new EdgeAttemptFailure("connection-unavailable", true);
    }
    if ("cause" in error && error.cause !== error) return failure(error.cause);
  }
  return new EdgeAttemptFailure("invalid-response-or-transport");
}
function configuredTimeout() {
  const value = Number(process.env.EDGE_AGENT_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(value) || value < 100) throw new Error("EDGE_AGENT_TIMEOUT_MS must be at least 100ms");
  return Math.floor(value);
}

async function readLimitedResponse(response: Response, observe: (bytes: number) => void) {
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
      observe(value.byteLength);
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

function assertNoSensitiveEgress(response: CoreEdgeAgentResponse) {
  if (sanitizeSensitiveText(JSON.stringify(response)).filteredFields.length > 0) {
    throw new Error("Remote Edge Agent response failed egress DLP validation");
  }
}

function assertReplicaIdentity(response: Response, replica: EdgeReplica) {
    for (const [header, expected] of [
      ["x-edge-node-id", replica.nodeId === "unconfigured" ? null : replica.nodeId],
      ["x-edge-replica-id", replica.replicaId === "unconfigured" ? null : replica.replicaId],
      ["x-edge-corpus-version", replica.corpusVersion],
      ["x-edge-model-version", replica.modelVersion],
    ]) {
      if (expected && response.headers.get(header!) !== expected) throw new EdgeAttemptFailure("replica-identity-mismatch");
    }
}

async function executeRemote(
  request: EdgeAgentRequest,
  replica: EdgeReplica,
  attempt: EdgeAttempt,
  signal: AbortSignal,
) {
  try {
    const response = await fetch(replica.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-edge-agent-id": request.agentId,
        authorization: `Bearer ${replica.token}`,
        "x-edge-attempt-id": attempt.attemptId,
      },
      body: JSON.stringify(request),
      signal,
    });

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_EDGE_RESPONSE_BYTES) throw new Error("Edge Agent response size limit exceeded");
    const body = await readLimitedResponse(response, bytes => { attempt.responseBytesReceived += bytes; });
    if (!response.ok) {
      let code: unknown;
      let envelope: Record<string, unknown> = {};
      try { envelope = JSON.parse(body); code = envelope.code; } catch { /* Unknown failures are terminal. */ }
      if (envelope && typeof envelope === "object" && "usage" in envelope) {
        assertReplicaIdentity(response, replica);
        if (Object.keys(envelope).some(key => !["error", "code", "requestId", "agentId", "usage"].includes(key)) || envelope.requestId !== request.requestId || envelope.agentId !== request.agentId || !["inference-invalid", "inference-unavailable"].includes(String(code))) throw new EdgeAttemptFailure("invalid-response-or-transport");
        const usage = envelope.usage as Record<string, unknown>;
        if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).some(key => !["model", "promptTokens", "completionTokens", "providerFinalObserved"].includes(key)) || typeof usage.model !== "string" || usage.model.length > 256 || sanitizeSensitiveText(JSON.stringify(usage)).filteredFields.length) throw new EdgeAttemptFailure("invalid-response-or-transport");
        for (const value of [usage.promptTokens, usage.completionTokens]) if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new EdgeAttemptFailure("invalid-response-or-transport");
        if (usage.providerFinalObserved !== undefined && typeof usage.providerFinalObserved !== "boolean") throw new EdgeAttemptFailure("invalid-response-or-transport");
        attempt.providerFinalObserved = usage.providerFinalObserved === true && replica.nodeId !== "unconfigured" && replica.replicaId !== "unconfigured" && Boolean(replica.corpusVersion && replica.modelVersion);
        attempt.model = usage.model; attempt.backend = "ollama";
        attempt.promptTokens = usage.promptTokens as number | null;
        attempt.completionTokens = usage.completionTokens as number | null;
        attempt.usageStatus = usage.promptTokens !== null && usage.completionTokens !== null ? "measured" : "unknown";
      } else if (response.headers.has("x-edge-node-id")) assertReplicaIdentity(response, replica);
      if ([502, 503, 504].includes(response.status) && (code === "inference-unavailable" || code === "edge-unavailable")) throw new EdgeAttemptFailure(code, true);
      if (code === "inference-invalid") throw new EdgeAttemptFailure("inference-invalid");
      throw new EdgeAttemptFailure(`http-${response.status}`);
    }
    assertReplicaIdentity(response, replica);
    let parsed: CoreEdgeAgentResponse;
    try {
      parsed = validateCoreEdgeAgentResponse(JSON.parse(body));
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
    const evidenceBytes = new TextEncoder().encode(JSON.stringify(parsed.evidenceRefs)).length;
    if (parsed.boundary.returnedBytes !== actualBytes ||
        parsed.metrics.egressBytes !== actualBytes ||
        parsed.boundary.evidencePayloadBytes !== evidenceBytes) {
      throw new Error("Remote Edge Agent response boundary metrics are inconsistent");
    }
    attempt.backend = parsed.metrics.backend;
    attempt.model = parsed.metrics.model;
    attempt.promptTokens = parsed.metrics.promptTokens;
    attempt.completionTokens = parsed.metrics.completionTokens;
    attempt.ttftMs = parsed.metrics.ttftMs;
    attempt.tpotMs = parsed.metrics.tpotMs;
    // Provider generation rate inferred from measured provider time/token (rounded upstream).
    attempt.tokensPerSecond = parsed.metrics.backend === "ollama" && parsed.metrics.tpotMs !== null && parsed.metrics.tpotMs > 0
      ? 1000 / parsed.metrics.tpotMs : null;
    attempt.usageStatus = parsed.metrics.backend === "deterministic" && ["not-configured", "edge-status"].includes(parsed.metrics.fallbackReasonCode ?? "") ? "not-started" :
      parsed.metrics.promptTokens !== null && parsed.metrics.completionTokens !== null ? "measured" : "unknown";
    signal.throwIfAborted();
    return parsed;
  } catch (error) { throw failure(error); }

}

/** Core가 사용하는 유일한 RAG/Agent 진입점. corpus 모듈을 정적으로 import하지 않는다. */
export async function executeEdgeAgent(
  untrustedRequest: unknown,
  signal?: AbortSignal,
): Promise<CoreEdgeAgentResponse> {
  const validatedRequest = validateEdgeAgentRequest(untrustedRequest);
  const request: EdgeAgentRequest = {
    ...validatedRequest,
    minimalQuery: sanitizeSensitiveText(validatedRequest.minimalQuery).sanitized,
  };
  const mode = (process.env.EDGE_AGENT_MODE ?? "auto").trim().toLowerCase();
  const baseUrl = process.env[`EDGE_AGENT_${request.agentId.toUpperCase()}_BASE_URL`] ?? process.env.EDGE_AGENT_BASE_URL;
  if (mode === "remote" || (mode === "auto" && baseUrl)) {
    signal?.throwIfAborted();
    const replicas = resolveEdgeReplicas(request.agentId);
    const timeoutMs = configuredTimeout();
    const runId = request.traceId ?? request.requestId;
    const deadlineAt = Math.min(Date.now() + request.limits.deadlineMs, remoteAgentBudget(runId, request.agentId) ?? Infinity);
    let finalError: unknown;
    for (const [index, replica] of replicas.entries()) {
      signal?.throwIfAborted();
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new EdgeAttemptFailure("agent-budget-exceeded");
      const reserve = replicas.length > 1 && index === 0 ? Math.min(timeoutMs, Math.floor(remaining / 2)) : 0;
      const attemptDeadline = Math.min(deadlineAt - reserve, Date.now() + timeoutMs);
      const attempt: EdgeAttempt = {
        attemptId: `${request.requestId}-${crypto.randomUUID()}`, requestId: runId, agentId: request.agentId,
        nodeId: replica.nodeId, replicaId: replica.replicaId, role: replica.role,
        startedAt: Date.now(), completedAt: Date.now(), elapsedMs: 0, queueWaitMs: 0,
        requestBytesPrepared: 0, responseBytesReceived: 0, status: "failed", reasonCode: null,
        backend: null, model: null, promptTokens: null, completionTokens: null, usageStatus: "not-started", adopted: false,
      };
      let dispatchedAt: number | null = null;
      let finished = false;
      try {
        const scheduled = await scheduleEdgeAttempt({
          requestId: runId, agentId: request.agentId, attemptId: attempt.attemptId,
          endpoint: replica.endpoint, nodeId: replica.nodeId,
          deadlineAt: attemptDeadline, attempt: index + 1, signal,
          async execute(scheduledSignal) {
            dispatchedAt = Date.now();
            if (attemptDeadline - Date.now() < 100) throw new EdgeAttemptFailure("attempt-timeout", true);
            const budgetedRequest = { ...request, limits: { ...request.limits, deadlineMs: Math.max(1, attemptDeadline - Date.now()) } };
            attempt.requestBytesPrepared = new TextEncoder().encode(JSON.stringify(budgetedRequest)).length;
            attempt.usageStatus = "unknown";
            try { return await executeRemote(budgetedRequest, replica, attempt, scheduledSignal); }
            finally { if (finished) recordEdgeAttempt(runId, attempt); }
          },
        });
        signal?.throwIfAborted();
        if (Date.now() >= deadlineAt) throw new EdgeAttemptFailure("agent-budget-exceeded");
        attempt.status = "succeeded";
        attempt.adopted = true;
        return scheduled.value;
      } catch (error) {
        const classified = failure(error);
        attempt.status = signal?.aborted || classified.reasonCode === "cancelled" ? "cancelled" : "failed";
        attempt.reasonCode = signal?.aborted ? "caller-cancelled" : classified.reasonCode;
        finalError = classified;
        if (signal?.aborted || !classified.retryable || index === replicas.length - 1 || Date.now() >= deadlineAt) throw classified;
      } finally {
        finished = true;
        attempt.completedAt = Date.now();
        attempt.elapsedMs = attempt.completedAt - attempt.startedAt;
        attempt.queueWaitMs = (dispatchedAt ?? attempt.completedAt) - attempt.startedAt;
        recordEdgeAttempt(runId, attempt);
      }
    }
    throw finalError;
  }
  if (mode !== "auto" && mode !== "local") {
    throw new Error(`지원하지 않는 EDGE_AGENT_MODE: ${mode}`);
  }
  if (process.env.NODE_ENV === "production" && process.env.EDGE_AGENT_REQUIRE_REMOTE === "true") {
    throw new Error("운영 환경에서는 remote Edge Agent가 필수입니다.");
  }
  // 단일 프로세스 프로토타입용 논리 경계다. 운영에서는 EDGE_AGENT_MODE=remote를 사용한다.
  const { executeEdgeAgentLocally } = await import("./edge-agent-service");
  const localResponse = await executeEdgeAgentLocally(request, signal);
  const projected = projectEdgeAgentResponseForCore(localResponse, "local");
  assertNoSensitiveEgress(projected);
  return projected;
}
