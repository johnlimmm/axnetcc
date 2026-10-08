import { getDistributedRun } from "./distributed-metrics.ts";
import { projectDistributedTelemetry } from "./distributed-telemetry.ts";
/** Allowlisted execution telemetry, independent of the user-facing run registry. */
export const metricNames = ["latencyMs", "ttftMs", "tpotMs", "queueWaitMs", "inferenceMs", "calls", "tokens", "boundaryBytes", "privacyRiskScore", "qualityScore", "sensitiveTransmissionRatio", "agentSelectionRatio", "originalDisclosureRatio", "citationCoverage", "citationValidity", "citationRecall", "groundedness", "evidenceSupport", "relevance", "domainCoverage", "answerCompleteness", "retrievalSuccessRate", "claimSupportRate", "minimizationRate"] as const;
export type TelemetryStatus = "running" | "integrating" | "completed" | "partial_failed" | "failed" | "cancelled";
export type TelemetryRun = {
  runId: string; revision: number; mode: string; status: TelemetryStatus;
  startedAt: number; updatedAt: number; completedAt: number | null;
  stage: string; backend: string | null; model: string | null;
  metrics: Record<typeof metricNames[number], number | null>;
  distributed: ReturnType<typeof projectDistributedTelemetry>;
  provenance: Record<string, string>;
  agents: Array<{ id: string; backend: string | null; latencyMs: number | null; ttftMs: number | null; tpotMs: number | null }>;
};
const terminal = new Set(["completed", "partial_failed", "failed", "cancelled"]);
const agentIds = new Set(["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"]);
const modes = new Set(["proposed", "parallel", "centralized", "managed", "masrouter", "remoterag"]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const backend = (value: unknown) => value === "ollama" || value === "deterministic" ? value : null;

export class TelemetryRegistry {
  readonly instanceId = crypto.randomUUID();
  readonly startedAt: number;
  private revision = 0;
  private droppedThrough = 0;
  private runs = new Map<string, TelemetryRun>();
  private clock: () => number;
  private capacity: number;
  constructor(clock: () => number = Date.now, capacity = 10_000) {
    this.clock = clock; this.capacity = capacity; this.startedAt = clock();
  }

  begin(runId: string, mode: string) {
    if (!/^RUN-[A-Za-z0-9-]{3,64}$/.test(runId) || this.runs.has(runId)) return;
    const now = this.clock();
    this.runs.set(runId, {
      runId, revision: ++this.revision, mode: modes.has(mode) ? mode : "unknown", status: "running",
      startedAt: now, updatedAt: now, completedAt: null, stage: "request.received", backend: null, model: null,
      metrics: Object.fromEntries(metricNames.map((name) => [name, null])) as TelemetryRun["metrics"], provenance: {}, agents: [], distributed: null,
    });
    this.prune();
  }

  progress(runId: string, stage: string) {
    const run = this.runs.get(runId);
    if (!run || terminal.has(run.status)) return;
    if (!/^(request|router|agents?|central|evidence|judge)\.[a-z-]+$/.test(stage)) return;
    run.stage = stage;
    run.status = stage.startsWith("central.") || stage.startsWith("judge.") ? "integrating" : "running";
    run.updatedAt = this.clock(); run.revision = ++this.revision;
  }

  finish(runId: string, status: TelemetryStatus, result?: unknown) {
    const run = this.runs.get(runId);
    if (!run || terminal.has(run.status) || !terminal.has(status)) return;
    const output = object(result), metrics = object(output.metrics), breakdown = object(metrics.latencyBreakdown);
    const fields = object(object(metrics.provenance).fields), privacy = object(metrics.privacyRisk);
    for (const name of metricNames) {
      run.metrics[name] = number(name === "queueWaitMs" || name === "inferenceMs" ? breakdown[name] : ["sensitiveTransmissionRatio", "agentSelectionRatio", "originalDisclosureRatio"].includes(name) ? privacy[name] : metrics[name]);
      const kind = object(fields[name]).kind;
      run.provenance[name] = ["measured", "derived", "estimated", "unavailable"].includes(String(kind)) ? String(kind) : run.metrics[name] === null ? "unavailable" : "unspecified";
    }
    // TTFT/TPOT remain null for fallback executions with no token timing.
    run.backend = backend(metrics.llmBackend);
    const model = metrics.model;
    run.model = typeof model === "string" && /^[a-zA-Z0-9._:/+ -]{1,120}$/.test(model) ? model : null;
    run.agents = (Array.isArray(output.agents) ? output.agents : []).map(object)
      .filter((agent) => agent.selected === true && agentIds.has(String(agent.id)))
      .map((agent) => ({ id: String(agent.id), backend: backend(object(agent.inference).backend), latencyMs: number(agent.latencyMs), ttftMs: number(object(agent.inference).ttftMs), tpotMs: number(object(agent.inference).tpotMs) }));
    run.status = status; run.stage = `request.${status}`; run.completedAt = this.clock();
    run.updatedAt = run.completedAt; run.revision = ++this.revision;
    this.prune();
  }

  snapshot(after = 0, instanceId?: string) {
    this.prune();
    // Attempt completion can arrive after cancellation or the final service event.
    // Publish it as a new revision so incremental scrapes cannot miss late costs.
    for (const run of this.runs.values()) {
      const current = projectDistributedTelemetry(getDistributedRun(run.runId), run.runId);
      if (current && JSON.stringify(current) !== JSON.stringify(run.distributed)) {
        run.distributed = current;
        run.updatedAt = this.clock(); run.revision = ++this.revision;
      }
    }
    const cursor = instanceId === this.instanceId ? after : 0;
    const changed = [...this.runs.values()].filter((run) => run.revision > cursor).sort((a, b) => a.revision - b.revision);
    const page = changed.slice(0, 500);
    return structuredClone({
      schemaVersion: "mnc-telemetry/v1", instanceId: this.instanceId, startedAt: this.startedAt, capturedAt: this.clock(),
      nextCursor: page.at(-1)?.revision ?? this.revision, hasMore: changed.length > page.length,
      gap: cursor < this.droppedThrough, droppedThrough: this.droppedThrough,
      active: [...this.runs.values()].filter((run) => !terminal.has(run.status)).length, runs: page,
    });
  }

  private prune() {
    const finished = [...this.runs.values()].filter((run) => run.completedAt !== null).sort((a, b) => a.revision - b.revision);
    for (const run of finished) {
      if (this.runs.size <= this.capacity && run.completedAt! >= this.clock() - 86_400_000) break;
      this.droppedThrough = Math.max(this.droppedThrough, run.revision); this.runs.delete(run.runId);
    }
  }
}

export const telemetry = new TelemetryRegistry();
