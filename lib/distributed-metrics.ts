import { executionLog } from "./execution-log.ts";
type Timing = { ttftMs?: number | null; tpotMs?: number | null; tokensPerSecond?: number | null };
export type EdgeAttempt = Timing & {
  providerFinalObserved?: boolean;
  attemptId: string; requestId: string; agentId: string; nodeId: string; replicaId: string;
  role: "primary" | "backup"; startedAt: number; completedAt: number; elapsedMs: number;
  queueWaitMs: number; requestBytesPrepared: number; responseBytesReceived: number;
  status: "succeeded" | "failed" | "cancelled"; reasonCode: string | null;
  backend: "ollama" | "deterministic" | null; model: string | null;
  promptTokens: number | null; completionTokens: number | null;
  usageStatus: "measured" | "unknown" | "not-started"; adopted: boolean;
};
export type InferenceMetrics = Timing & {
  providerFinalObserved?: boolean;
  failureCode?: "configuration" | "connection" | "timeout" | "invalid-response" | "provider-error";
  callId?: string;
  nodeId?: string | null; startedAt?: number | null; endedAt?: number | null;
  status?: "succeeded" | "failed" | "cancelled" | null;
  requestBytesPrepared?: number | null; requestSubmitted?: boolean | null; responseBytesReceived?: number | null;
  backend: "ollama" | "deterministic"; model: string;
  promptTokens: number | null; completionTokens: number | null;
};
type InferenceStage = "synthesis" | "supervisor" | "repair" | "verification" | "evaluation";
type InferenceCall = InferenceMetrics & { callId: string; stage: InferenceStage; detail: "per-call" | "legacy-stage-only" };
type Run = { attempts: Map<string, EdgeAttempt>; stages: Map<string, InferenceCall>; accountingFailures: Set<string> };
const runs = new Map<string, Run>();
function run(id: string) {
  let value = runs.get(id);
  if (!value) {
    value = { attempts: new Map(), stages: new Map(), accountingFailures:new Set() };
    runs.set(id, value);
    if (runs.size > 10_000) runs.delete(runs.keys().next().value!);
  }
  return value;
}
function counter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function timing(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function inferenceFailureCode(value:unknown): InferenceMetrics["failureCode"] {
  return ["configuration","connection","timeout","invalid-response","provider-error"].includes(String(value)) ? value as InferenceMetrics["failureCode"] : undefined;
}
function identifier(value: string, maximum = 160) {
  return typeof value === "string" && value.length <= maximum && /^[a-zA-Z0-9_-]+$/.test(value) ? value : "invalid";
}
function modelName(value: string | null) {
  return value !== null && value.length <= 256 && /^[a-zA-Z0-9_.:/-]+$/.test(value) && !value.includes("://") ? value : null;
}
export function recordEdgeAttempt(requestId: string, attempt: EdgeAttempt) {
  const target = run(requestId);
  if (target.attempts.size >= 64 && !target.attempts.has(attempt.attemptId)) return;
  for (const value of [attempt.startedAt, attempt.completedAt, attempt.elapsedMs, attempt.queueWaitMs, attempt.requestBytesPrepared, attempt.responseBytesReceived]) {
    if (counter(value) === null) throw new Error("Invalid distributed attempt numeric metric");
  }
  const promptTokens = counter(attempt.promptTokens);
  const completionTokens = counter(attempt.completionTokens);
  const clean: EdgeAttempt = {
    providerFinalObserved: attempt.providerFinalObserved === true,
    attemptId: identifier(attempt.attemptId, 200), requestId: identifier(requestId),
    agentId: identifier(attempt.agentId), nodeId: identifier(attempt.nodeId), replicaId: identifier(attempt.replicaId),
    role: attempt.role === "backup" ? "backup" : "primary",
    startedAt: attempt.startedAt, completedAt: attempt.completedAt,
    elapsedMs: attempt.elapsedMs, queueWaitMs: attempt.queueWaitMs,
    requestBytesPrepared: attempt.requestBytesPrepared,
    responseBytesReceived: attempt.responseBytesReceived,
    status: ["succeeded", "failed", "cancelled"].includes(attempt.status) ? attempt.status : "failed",
    reasonCode: attempt.reasonCode === null ? null : identifier(attempt.reasonCode, 64),
    backend: attempt.backend === "ollama" || attempt.backend === "deterministic" ? attempt.backend : null,
    model: modelName(attempt.model), promptTokens, completionTokens,
    ttftMs: timing(attempt.ttftMs), tpotMs: timing(attempt.tpotMs), tokensPerSecond: timing(attempt.tokensPerSecond),
    usageStatus: attempt.usageStatus === "not-started" ? "not-started" : promptTokens !== null && completionTokens !== null ? "measured" : "unknown",
    adopted: attempt.adopted === true && attempt.status === "succeeded",
  };
  target.attempts.set(clean.attemptId, clean);
  executionLog("core-attempt-completed", clean);
}
/** Explicit call IDs are stable across event replay, unique across physical invocations. */
export function recordInferenceStage(requestId: string, stage: InferenceStage, metrics: InferenceMetrics, callId = metrics.callId) {
  const target = run(requestId);
  const key = callId ? identifier(callId, 200) : `legacy-${stage}`;
  if (key === "invalid") throw new Error("Invalid inference call ID");
  if (target.stages.has(key)) return;
  if (target.stages.size >= 64) throw new Error("Inference call limit exceeded");
  target.stages.set(key, { callId: key, stage, detail: callId ? "per-call" : "legacy-stage-only",
    providerFinalObserved: metrics.providerFinalObserved === true, failureCode: inferenceFailureCode(metrics.failureCode),
    nodeId: metrics.nodeId && identifier(metrics.nodeId) !== "invalid" ? identifier(metrics.nodeId) : null,
    startedAt: counter(metrics.startedAt), endedAt: counter(metrics.endedAt) !== null && counter(metrics.startedAt) !== null && metrics.endedAt! >= metrics.startedAt! ? counter(metrics.endedAt) : null,
    status: metrics.status === "succeeded" || metrics.status === "failed" || metrics.status === "cancelled" ? metrics.status : null,
    requestBytesPrepared: counter(metrics.requestBytesPrepared), requestSubmitted: typeof metrics.requestSubmitted === "boolean" ? metrics.requestSubmitted : null,
    responseBytesReceived: counter(metrics.responseBytesReceived),
    backend: metrics.backend, model: modelName(metrics.model) ?? "unknown",
    ttftMs: timing(metrics.ttftMs), tpotMs: timing(metrics.tpotMs), tokensPerSecond: timing(metrics.tokensPerSecond),
    promptTokens: counter(metrics.promptTokens), completionTokens: counter(metrics.completionTokens) });
  executionLog("core-inference-completed", { requestId, attemptId: key, nodeId: metrics.nodeId, status: metrics.status,
    elapsedMs: metrics.endedAt != null && metrics.startedAt != null ? metrics.endedAt - metrics.startedAt : null });
}
/** Independent fail-closed record; stable IDs prevent double counting after a late callback throw. */
export function markInferenceAccountingIncomplete(requestId:string, stage:InferenceStage, metrics:InferenceMetrics, callId:string) {
  const target = run(requestId), key = identifier(callId,200);
  target.accountingFailures.add(key);
  if (!target.stages.has(key) && target.stages.size < 64) target.stages.set(key, { callId:key,stage,detail:"per-call",backend:metrics.backend,model:modelName(metrics.model) ?? "unknown",
    providerFinalObserved:metrics.providerFinalObserved === true,failureCode:inferenceFailureCode(metrics.failureCode),
    nodeId:metrics.nodeId && identifier(metrics.nodeId) !== "invalid" ? identifier(metrics.nodeId) : null,
    startedAt:counter(metrics.startedAt),endedAt:counter(metrics.endedAt),status:metrics.status ?? null,
    requestBytesPrepared:counter(metrics.requestBytesPrepared),requestSubmitted:metrics.requestSubmitted ?? null,responseBytesReceived:counter(metrics.responseBytesReceived),
    promptTokens:counter(metrics.promptTokens),completionTokens:counter(metrics.completionTokens) });
}
export function getDistributedRun(requestId: string) {
  const value = runs.get(requestId);
  if (!value) return null;
  const accountingIncomplete = value.accountingFailures.size > 0;
  const attempts = [...value.attempts.values()].map(item => ({ ...item }));
  const calls = [...value.stages.values()].map(item => ({ ...item }));
  const stages = [...new Set(calls.map(item => item.stage))].map(stage => {
    const selected = calls.filter(item => item.stage === stage);
    const unknown = selected.some(item => value.accountingFailures.has(item.callId) || item.promptTokens === null || item.completionTokens === null);
    return { stage, backend: selected.every(item => item.backend === "ollama") ? "ollama" as const : "deterministic" as const, model: new Set(selected.map(item => item.model)).size === 1 ? selected[0].model : "multiple",
      promptTokens: unknown ? null : selected.reduce((sum, item) => sum + item.promptTokens!, 0),
      completionTokens: unknown ? null : selected.reduce((sum, item) => sum + item.completionTokens!, 0), callCount: selected.length };
  });
  const inference = [...attempts.filter(item => item.usageStatus !== "not-started"), ...calls];
  const knownPromptTokens = inference.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0);
  const knownCompletionTokens = inference.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0);
  const unknownCount = inference.filter(item => item.promptTokens === null || item.completionTokens === null).length;
  const usageByCategory = Object.fromEntries([
    ["agent", attempts.filter(item => item.usageStatus !== "not-started")],
    ["core", calls.filter(item => item.stage === "synthesis" || item.stage === "supervisor")],
    ["onlineVerification", calls.filter(item => item.stage === "repair" || item.stage === "verification")],
    ["evaluation", calls.filter(item => item.stage === "evaluation")],
  ].map(([name, items]) => {
    const records = items as { promptTokens: number | null; completionTokens: number | null }[];
    const unknown = accountingIncomplete || records.some(item => item.promptTokens === null || item.completionTokens === null);
    const knownPromptTokens = records.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0);
    const knownCompletionTokens = records.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0);
    return [name, { inferenceCount: records.length, promptTokens: unknown ? null : knownPromptTokens,
      completionTokens: unknown ? null : knownCompletionTokens, knownPromptTokens, knownCompletionTokens }];
  }));
  const coreCalls = calls.filter(item => item.stage === "synthesis" || item.stage === "supervisor");
  const coreBody = (key: "requestBytesPrepared" | "responseBytesReceived") => ({
    value: accountingIncomplete || coreCalls.some(item => item[key] === null || item[key] === undefined) ? null : coreCalls.reduce((sum,item) => sum + (item[key] ?? 0),0),
    known: coreCalls.reduce((sum,item) => sum + (item[key] ?? 0),0),
    unknownCount: coreCalls.filter(item => item[key] === null || item[key] === undefined).length,
  });
  const coreBodyBytes = { requestBytesPrepared:coreBody("requestBytesPrepared"), responseBytesReceived:coreBody("responseBytesReceived"),
    submittedCallCount:coreCalls.filter(item => item.requestSubmitted === true).length,
    submissionUnknownCount:coreCalls.filter(item => item.requestSubmitted === null || item.requestSubmitted === undefined).length,
    semantics:"Prepared request body; submission means fetch invoked, not delivery or NIC traffic; received response body only" };
  return { version: "1" as const, requestId, deploymentId: process.env.DEMO_DEPLOYMENT_ID ? identifier(process.env.DEMO_DEPLOYMENT_ID) : null, source: process.env.DEMO_DEPLOYMENT_ID ? "configured-demo" : "unclassified", accountingIncomplete, accountingFailures: [...value.accountingFailures].map(callId => ({ callId, code: "metrics-callback-failed" as const })), attempts, stages, calls, usageByCategory, coreBodyBytes, callDetail: calls.some(item => item.detail === "legacy-stage-only") ? "legacy-stage-only" : "per-call", totals: {
    promptTokens: accountingIncomplete || unknownCount ? null : knownPromptTokens,
    completionTokens: accountingIncomplete || unknownCount ? null : knownCompletionTokens,
    knownPromptTokens, knownCompletionTokens, unknownCount, inferenceCount: inference.length,
    measuredCount: inference.length - unknownCount,
    requestBytesPrepared: attempts.reduce((sum, item) => sum + item.requestBytesPrepared, 0),
    responseBytesReceived: attempts.reduce((sum, item) => sum + item.responseBytesReceived, 0),
    retryKnownPromptTokens: attempts.filter(item => !item.adopted).reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
    retryKnownCompletionTokens: attempts.filter(item => !item.adopted).reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
  } };
}
