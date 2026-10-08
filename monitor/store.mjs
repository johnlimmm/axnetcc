import { projectDistributedTelemetry } from "../lib/distributed-telemetry.ts";
import { distributedSummary } from "./distributed.mjs";
import { DatabaseSync } from "node:sqlite";
import { metricNames } from "../lib/telemetry.ts";

export const terminalStatuses = new Set(["completed", "partial_failed", "failed", "cancelled", "interrupted"]);
const fields = metricNames;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function percentile(values, p) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
}

export function validatePacket(packet) {
  if (!packet || packet.schemaVersion !== "mnc-telemetry/v1" || typeof packet.instanceId !== "string" || !/^[a-f0-9-]{36}$/i.test(packet.instanceId) || !Array.isArray(packet.runs) || packet.runs.length > 500 || !Number.isSafeInteger(packet.nextCursor) || packet.nextCursor < 0 || !finite(packet.capturedAt) || !finite(packet.startedAt) || !Number.isSafeInteger(packet.active) || packet.active < 0 || typeof packet.hasMore !== "boolean") throw new Error("INVALID_TELEMETRY");
  for (const run of packet.runs) {
    if (!/^RUN-[A-Za-z0-9-]{3,64}$/.test(run.runId) || !Number.isSafeInteger(run.revision) || run.revision < 1 || run.revision > packet.nextCursor || !finite(run.startedAt) || !finite(run.updatedAt) || !["running", "integrating", "completed", "partial_failed", "failed", "cancelled"].includes(run.status) || !["proposed", "managed", "parallel", "centralized", "masrouter", "remoterag", "unknown"].includes(run.mode)) throw new Error("INVALID_TELEMETRY_RUN");
    if (terminalStatuses.has(run.status) && !finite(run.completedAt)) throw new Error("INVALID_COMPLETED_AT");
    if (!run.metrics || fields.some(key => run.metrics[key] !== null && !finite(run.metrics[key]))) throw new Error("INVALID_METRICS");
  }
}

function projectRun(run) {
  return {
    runId: run.runId, revision: run.revision, mode: run.mode, status: run.status,
    startedAt: run.startedAt, updatedAt: run.updatedAt, completedAt: run.completedAt ?? null,
    stage: typeof run.stage === "string" && /^[a-z._-]{1,70}$/.test(run.stage) ? run.stage : "unknown",
    backend: ["ollama", "deterministic"].includes(run.backend) ? run.backend : null,
    model: typeof run.model === "string" && /^[a-zA-Z0-9._:/+ -]{1,120}$/.test(run.model) ? run.model : null,
    metrics: Object.fromEntries(fields.map(key => [key, run.metrics[key]])),
    provenance: Object.fromEntries(fields.map(key => [key, ["measured", "derived", "estimated", "unavailable", "unspecified"].includes(run.provenance?.[key]) ? run.provenance[key] : "unavailable"])),
    distributed: projectDistributedTelemetry(run.distributed, run.runId),
    agents: (Array.isArray(run.agents) ? run.agents : []).filter(agent => ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"].includes(agent.id)).map(agent => ({ id: agent.id, backend: ["ollama", "deterministic"].includes(agent.backend) ? agent.backend : null, latencyMs: finite(agent.latencyMs) ? agent.latencyMs : null, ttftMs: finite(agent.ttftMs) ? agent.ttftMs : null, tpotMs: finite(agent.tpotMs) ? agent.tpotMs : null })),
  };
}

export function openMonitorStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (instance_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, mode TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(instance_id, run_id));
    CREATE INDEX IF NOT EXISTS runs_time ON runs(completed_at, started_at);
    CREATE TABLE IF NOT EXISTS samples (at INTEGER PRIMARY KEY, ok INTEGER NOT NULL, active INTEGER, health TEXT, error TEXT);
  `);
  const getMeta = key => { const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key); return row ? JSON.parse(row.value) : null; };
  const setMeta = (key, value) => db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  return {
    cursor: () => ({ instance: getMeta("instance") ?? "", after: getMeta("cursor") ?? 0 }),
    ingest(packet, collectedAt = Date.now()) {
      validatePacket(packet);
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = getMeta("instance");
        if (previous && previous !== packet.instanceId) {
          // A source restart does not prove an execution failure. Keep an explicit interruption state.
          for (const row of db.prepare("SELECT instance_id, run_id, payload FROM runs WHERE status IN ('running','integrating')").all()) {
            const run = JSON.parse(row.payload); run.status = "interrupted"; run.completedAt = collectedAt; run.stage = "source.restarted";
            db.prepare("UPDATE runs SET status='interrupted', completed_at=?, payload=? WHERE instance_id=? AND run_id=?").run(collectedAt, JSON.stringify(run), row.instance_id, row.run_id);
          }
          setMeta("sourceRestarts", (getMeta("sourceRestarts") ?? 0) + 1);
        }
        if (packet.gap) setMeta("lastGapAt", collectedAt);
        for (const raw of packet.runs) {
          const run = projectRun(raw);
          db.prepare(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(instance_id,run_id) DO UPDATE SET revision=excluded.revision, completed_at=excluded.completed_at, status=excluded.status, payload=excluded.payload WHERE excluded.revision > runs.revision`)
            .run(packet.instanceId, run.runId, run.revision, run.startedAt, run.completedAt, run.mode, run.status, JSON.stringify(run));
        }
        setMeta("instance", packet.instanceId);
        setMeta("cursor", previous === packet.instanceId ? Math.max(getMeta("cursor") ?? 0, packet.nextCursor) : packet.nextCursor);
        setMeta("lastSuccessAt", collectedAt);
        setMeta("sourceStartedAt", packet.startedAt);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    sample({ at, ok, active = null, health = null, error = null }) {
      db.prepare("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?)").run(at, ok ? 1 : 0, active, health ? JSON.stringify(health) : null, error);
    },
    prune(before) {
      db.prepare("DELETE FROM runs WHERE completed_at IS NOT NULL AND completed_at < ?").run(before);
      db.prepare("DELETE FROM samples WHERE at < ?").run(before);
    },
    summary({ from, to, mode = "all", backend = "all" }, now = Date.now()) {
      const observed = db.prepare("SELECT instance_id, payload FROM runs WHERE COALESCE(completed_at,started_at) BETWEEN ? AND ? ORDER BY COALESCE(completed_at,started_at) DESC").all(from, to)
        .map(row => ({ ...JSON.parse(row.payload), instanceId: row.instance_id }))
        .filter(run => (mode === "all" || run.mode === mode) && (backend === "all" || run.backend === backend));
      const completed = observed.filter(run => terminalStatuses.has(run.status));
      const settled = completed.filter(run => run.status !== "interrupted");
      const successful = completed.filter(run => run.status === "completed" || run.status === "partial_failed");
      const readings = key => successful.map(run => run.metrics[key]).filter(finite);
      const errors = settled.filter(run => run.status === "failed" || run.status === "partial_failed").length;
      const width = Math.max(60_000, Math.ceil((to - from) / 60));
      const bins = new Map();
      for (const run of settled) {
        const at = from + Math.floor((run.completedAt - from) / width) * width;
        const bin = bins.get(at) ?? { at, count: 0, errors: 0, latencies: [] };
        bin.count++; if (["failed", "partial_failed"].includes(run.status)) bin.errors++;
        if (finite(run.metrics.latencyMs)) bin.latencies.push(run.metrics.latencyMs);
        bins.set(at, bin);
      }
      const samples = db.prepare("SELECT * FROM samples WHERE at BETWEEN ? AND ? ORDER BY at").all(from, to);
      const latest = db.prepare("SELECT * FROM samples ORDER BY at DESC LIMIT 1").get();
      const agents = new Map();
      for (const run of successful) for (const agent of run.agents) {
        const row = agents.get(agent.id) ?? { id: agent.id, calls: 0, fallback: 0, latencies: [] };
        row.calls++; if (agent.backend === "deterministic") row.fallback++; if (finite(agent.latencyMs)) row.latencies.push(agent.latencyMs); agents.set(agent.id, row);
      }
      return {
        range: { from, to, mode, backend }, capturedAt: now,
        distributed: distributedSummary(observed),
        collector: { lastSuccessAt: getMeta("lastSuccessAt"), sourceStartedAt: getMeta("sourceStartedAt"), lastGapAt: getMeta("lastGapAt"), sourceRestarts: getMeta("sourceRestarts") ?? 0, latest: latest ? { ...latest, health: latest.health ? JSON.parse(latest.health) : null } : null },
        totals: { runs: settled.length, successful: settled.filter(run => run.status === "completed").length, errors, cancelled: settled.filter(run => run.status === "cancelled").length, interrupted: completed.filter(run => run.status === "interrupted").length, errorRate: settled.length ? errors / settled.length : null, throughputPerMinute: settled.length / Math.max((to - from) / 60_000, 1), e2eP50: percentile(readings("latencyMs"), .5), e2eP95: percentile(readings("latencyMs"), .95), e2eSamples: readings("latencyMs").length, ttft: average(readings("ttftMs")), tpot: average(readings("tpotMs")), tokens: readings("tokens").length ? readings("tokens").reduce((a, b) => a + b, 0) : null, tokenSamples: readings("tokens").length, fallback: successful.filter(run => run.backend === "deterministic" || run.agents.some(agent => agent.backend === "deterministic")).length },
        series: [...bins.values()].sort((a, b) => a.at - b.at).map(bin => ({ at: bin.at, count: bin.count, errors: bin.errors, p50: percentile(bin.latencies, .5), p95: percentile(bin.latencies, .95) })),
        sampleSeries: samples.filter((_, index) => index % Math.max(1, Math.ceil(samples.length / 120)) === 0).map(row => ({ at: row.at, ok: Boolean(row.ok), active: row.active })),
        runs: observed.slice(0, 200), agents: [...agents.values()].map(row => ({ id: row.id, calls: row.calls, fallback: row.fallback, p95: percentile(row.latencies, .95) })),
      };
    },
    findRun(instance, id) { const row = db.prepare("SELECT payload FROM runs WHERE instance_id=? AND run_id=?").get(instance, id); return row ? JSON.parse(row.payload) : null; },
    close() { db.close(); },
  };
}
