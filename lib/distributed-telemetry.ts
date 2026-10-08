/** A second allowlist at the telemetry boundary. No prompt, URL or exception text crosses it. */
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const identifier = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
const modelName = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9._:/+ -]{1,120}$/.test(value) && !value.includes("://") ? value : null;
const backend = (value: unknown): "ollama" | "deterministic" | null => value === "ollama" || value === "deterministic" ? value : null;
const agentIds = new Set(["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"]);
const reasons = new Set(["cancelled", "caller-cancelled", "attempt-timeout", "agent-budget-exceeded", "connection-unavailable", "inference-unavailable", "inference-invalid", "edge-unavailable", "invalid-response-or-transport", "replica-identity-mismatch", "configuration-invalid"]);

export function projectDistributedTelemetry(value: unknown, requestId: string) {
  const raw = object(value);
  if (raw.version !== "1" || raw.requestId !== requestId || !Array.isArray(raw.attempts) || !Array.isArray(raw.stages) || raw.attempts.length > 64 || raw.stages.length > 8) return null;
  const accountingIncomplete = raw.accountingIncomplete === true;
  const accountingFailures = Array.isArray(raw.accountingFailures) ? raw.accountingFailures.slice(0,64).flatMap(value => {
    const item = object(value), callId = identifier(item.callId);
    return callId && item.code === "metrics-callback-failed" ? [{callId,code:"metrics-callback-failed"}] : [];
  }) : [];
  const unique = new Map<string, ReturnType<typeof projectAttempt>>();
  function projectAttempt(value: unknown) {
    const item = object(value);
    const attemptId = identifier(item.attemptId), agentId = identifier(item.agentId);
    if (!attemptId || !agentId || !agentIds.has(agentId) || !identifier(item.requestId) ||
      !identifier(item.nodeId) || !identifier(item.replicaId) ||
      !["primary", "backup"].includes(String(item.role)) || !["succeeded", "failed", "cancelled"].includes(String(item.status))) return null;
    const reason = typeof item.reasonCode === "string" && (reasons.has(item.reasonCode) || /^http-[1-5][0-9]{2}$/.test(item.reasonCode)) ? item.reasonCode : item.reasonCode === null ? null : "unknown-failure";
    return {
      providerFinalObserved: item.providerFinalObserved === true,
      attemptId, requestId: String(item.requestId), agentId, nodeId: String(item.nodeId), replicaId: String(item.replicaId),
      role: item.role as "primary" | "backup", status: item.status as "succeeded" | "failed" | "cancelled", reasonCode: reason,
      startedAt: count(item.startedAt), completedAt: count(item.completedAt), elapsedMs: duration(item.elapsedMs), queueWaitMs: duration(item.queueWaitMs),
      requestBytesPrepared: count(item.requestBytesPrepared), responseBytesReceived: count(item.responseBytesReceived),
      backend: backend(item.backend), model: modelName(item.model), promptTokens: count(item.promptTokens), completionTokens: count(item.completionTokens),
      ttftMs: duration(item.ttftMs), tpotMs: duration(item.tpotMs), tokensPerSecond: duration(item.tokensPerSecond),
      usageStatus: ["measured", "not-started"].includes(String(item.usageStatus)) ? String(item.usageStatus) : "unknown",
      adopted: item.adopted === true && item.status === "succeeded",
    };
  }
  for (const item of raw.attempts.slice(0, 64)) { const projected = projectAttempt(item); if (!projected) return null; unique.set(projected.attemptId, projected); }
  const attempts = [...unique.values()].filter((item): item is NonNullable<typeof item> => item !== null);
  const stageMap = new Map<string, { stage: string; backend: "ollama" | "deterministic" | null; model: string | null; promptTokens: number | null; completionTokens: number | null }>();
  for (const value of raw.stages.slice(0, 8)) {
    const item = object(value);
    if (item.stage === "synthesis" || item.stage === "supervisor") stageMap.set(item.stage, { stage: item.stage, backend: backend(item.backend), model: modelName(item.model), promptTokens: count(item.promptTokens), completionTokens: count(item.completionTokens) });
  }
  const calls: { ttftMs: number | null; tpotMs: number | null; tokensPerSecond: number | null; providerFinalObserved: boolean; failureCode: string | null; nodeId: string | null; startedAt: number | null; endedAt: number | null; status: string | null; requestBytesPrepared: number | null; requestSubmitted: boolean | null; responseBytesReceived: number | null; callId: string; stage: string; detail: string; backend: "ollama" | "deterministic" | null; model: string | null; promptTokens: number | null; completionTokens: number | null }[] = [];
  if (raw.calls !== undefined) {
    if (!Array.isArray(raw.calls) || raw.calls.length > 64) return null;
    const seen = new Set<string>();
    for (const value of raw.calls) {
      const item = object(value), callId = identifier(item.callId);
      if (!callId || !["synthesis", "supervisor", "repair", "verification", "evaluation"].includes(String(item.stage))) return null;
      if (seen.has(callId)) continue;
      seen.add(callId);
      calls.push({ providerFinalObserved: item.providerFinalObserved === true, failureCode: ["configuration","connection","timeout","invalid-response","provider-error"].includes(String(item.failureCode)) ? String(item.failureCode) : null, nodeId: identifier(item.nodeId), startedAt: count(item.startedAt),
        ttftMs: duration(item.ttftMs), tpotMs: duration(item.tpotMs), tokensPerSecond: duration(item.tokensPerSecond),
        endedAt: count(item.endedAt) !== null && count(item.startedAt) !== null && Number(item.endedAt) >= Number(item.startedAt) ? count(item.endedAt) : null,
        status: ["succeeded","failed","cancelled"].includes(String(item.status)) ? String(item.status) : null,
        requestBytesPrepared: count(item.requestBytesPrepared), requestSubmitted: typeof item.requestSubmitted === "boolean" ? item.requestSubmitted : null,
        responseBytesReceived: count(item.responseBytesReceived), callId, stage: String(item.stage), detail: item.detail === "per-call" ? "per-call" : "legacy-stage-only",
        backend: backend(item.backend), model: modelName(item.model), promptTokens: count(item.promptTokens), completionTokens: count(item.completionTokens) });
    }
  }
  // Historical snapshots retain their known stage subtotal, but have no reconstructed call history.
  const historical = raw.calls === undefined || (raw.callDetail === "legacy-stage-only" && calls.length === 0);
  const stages = historical ? [...stageMap.values()] : [...new Set(calls.map(item => item.stage))].map(stage => {
    const selected = calls.filter(item => item.stage === stage);
    const unknown = accountingIncomplete || selected.some(item => item.promptTokens === null || item.completionTokens === null);
    return { stage, backend: selected.every(item => item.backend === "ollama") ? "ollama" as const : "deterministic" as const, model: new Set(selected.map(item => item.model)).size === 1 ? selected[0].model : "multiple", callCount: selected.length,
      promptTokens: unknown ? null : selected.reduce((sum, item) => sum + item.promptTokens!, 0),
      completionTokens: unknown ? null : selected.reduce((sum, item) => sum + item.completionTokens!, 0) };
  });
  const inference = [...attempts.filter(item => item.usageStatus !== "not-started"), ...(historical ? stages : calls)];
  const knownPromptTokens = inference.reduce((sum, item) => sum + (item.promptTokens ?? 0), 0);
  const knownCompletionTokens = inference.reduce((sum, item) => sum + (item.completionTokens ?? 0), 0);
  const unknownCount = inference.filter(item => item.promptTokens === null || item.completionTokens === null).length;
  const usageByCategory = Object.fromEntries([
    ["agent", attempts.filter(item => item.usageStatus !== "not-started")],
    ["core", (historical ? stages : calls).filter(item => item.stage === "synthesis" || item.stage === "supervisor")],
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
    value: accountingIncomplete || historical || coreCalls.some(item => item[key] === null) ? null : coreCalls.reduce((sum,item) => sum + (item[key] ?? 0),0),
    known: coreCalls.reduce((sum,item) => sum + (item[key] ?? 0),0),
    unknownCount: historical ? stages.filter(item => item.stage === "synthesis" || item.stage === "supervisor").length : coreCalls.filter(item => item[key] === null).length,
  });
  const coreBodyBytes = { requestBytesPrepared:coreBody("requestBytesPrepared"), responseBytesReceived:coreBody("responseBytesReceived"),
    submittedCallCount:coreCalls.filter(item => item.requestSubmitted === true).length,
    submissionUnknownCount:historical ? stages.length : coreCalls.filter(item => item.requestSubmitted === null).length,
    semantics:"Prepared request body; submission means fetch invoked, not delivery or NIC traffic; received response body only" };
  return { version: "1", requestId, deploymentId: identifier(raw.deploymentId),
    source: raw.source === "configured-demo" && identifier(raw.deploymentId) ? "configured-demo" : "unclassified",
    accountingIncomplete, accountingFailures, attempts, stages, calls, usageByCategory, coreBodyBytes, callDetail: historical || calls.some(item => item.detail !== "per-call") ? "legacy-stage-only" : "per-call", totals: {
    promptTokens: accountingIncomplete || unknownCount || !inference.length ? null : knownPromptTokens,
    completionTokens: accountingIncomplete || unknownCount || !inference.length ? null : knownCompletionTokens,
    knownPromptTokens, knownCompletionTokens, unknownCount, inferenceCount: inference.length, measuredCount: inference.length - unknownCount,
    requestBytesPrepared: attempts.some(item => item.requestBytesPrepared === null) ? null : attempts.reduce((sum, item) => sum + item.requestBytesPrepared!, 0),
    responseBytesReceived: attempts.some(item => item.responseBytesReceived === null) ? null : attempts.reduce((sum, item) => sum + item.responseBytesReceived!, 0),
    retryKnownPromptTokens: attempts.filter(item => !item.adopted).reduce((sum, item) => sum + (item.promptTokens ?? 0), 0),
    retryKnownCompletionTokens: attempts.filter(item => !item.adopted).reduce((sum, item) => sum + (item.completionTokens ?? 0), 0),
  } };
}
