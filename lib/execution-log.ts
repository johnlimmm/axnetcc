/** Opt-in execution metadata only; never accept arbitrary payload or exception text. */
export function executionLog(event: "edge-received" | "edge-completed" | "edge-failed" | "core-attempt-completed" | "core-inference-completed", fields: {
  requestId: string; agentId?: string; attemptId?: string; nodeId?: string | null;
  replicaId?: string | null; status?: string | null; elapsedMs?: number | null;
}) {
  if (typeof process === "undefined" || process.env.EXECUTION_LOG_ENABLED !== "true") return;
  const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
  try {
    console.log(JSON.stringify({ schema: "execution-log/v1", timestamp: new Date().toISOString(), event,
      requestId: id(fields.requestId), agentId: id(fields.agentId), attemptId: id(fields.attemptId),
      nodeId: id(fields.nodeId), replicaId: id(fields.replicaId), status: id(fields.status),
      elapsedMs: typeof fields.elapsedMs === "number" && Number.isFinite(fields.elapsedMs) && fields.elapsedMs >= 0 ? fields.elapsedMs : null }));
  } catch { /* Logging must never change service behavior. */ }
}
