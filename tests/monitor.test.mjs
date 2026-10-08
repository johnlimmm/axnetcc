import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelemetryRegistry } from "../lib/telemetry.ts";
import { openMonitorStore, percentile } from "../monitor/store.mjs";
import { createCollector } from "../monitor/collector.mjs";
import { startMonitor } from "../monitor/server.mjs";

const result = (latencyMs = 1000) => ({
  query: "SECRET REQUEST", conclusion: "SECRET ANSWER", metrics: { latencyMs, ttftMs: null, tpotMs: null, tokens: 0, calls: 0, llmBackend: "deterministic", model: "test-model", privacyRisk: { sensitiveTransmissionRatio: 0 }, provenance: { fields: { latencyMs: { kind: "measured", detail: "SECRET PROMPT" } } } },
  agents: [{ id: "tech", selected: true, latencyMs: 100, summary: "SECRET EVIDENCE", inference: { backend: "deterministic" } }],
});
const range = { from: 0, to: 1_000_000 };

test("telemetry allowlist preserves zero/null and records failures and cancellations without user content", () => {
  let now = 100;
  const registry = new TelemetryRegistry(() => now);
  registry.begin("RUN-safe-test", "proposed");
  registry.progress("RUN-safe-test", "central.generating");
  now += 1000;
  registry.finish("RUN-safe-test", "completed", result(0));
  registry.finish("RUN-safe-test", "failed");
  const packet = registry.snapshot();
  const run = packet.runs[0];
  assert.equal(run.status, "completed");
  assert.equal(run.metrics.latencyMs, 0);
  assert.equal(run.metrics.ttftMs, null);
  assert.equal(run.metrics.sensitiveTransmissionRatio, 0);
  assert.equal(run.provenance.latencyMs, "measured");
  assert.ok(!JSON.stringify(packet).includes("SECRET"));
  registry.begin("RUN-cancel-test", "managed"); registry.finish("RUN-cancel-test", "cancelled");
  registry.begin("RUN-failed-test", "parallel"); registry.finish("RUN-failed-test", "failed");
  assert.equal(registry.snapshot().active, 0);
  assert.equal(registry.snapshot(packet.nextCursor, packet.instanceId).runs.length, 2);
});

test("telemetry paginates incremental updates and makes buffer loss explicit", () => {
  const registry = new TelemetryRegistry(() => 1000);
  for (let i = 0; i < 510; i++) { registry.begin(`RUN-page-${i}`, "proposed"); registry.finish(`RUN-page-${i}`, "completed", result()); }
  const first = registry.snapshot();
  assert.equal(first.runs.length, 500); assert.equal(first.hasMore, true);
  const second = registry.snapshot(first.nextCursor, first.instanceId);
  assert.equal(second.runs.length, 10); assert.equal(second.hasMore, false);
  const small = new TelemetryRegistry(() => 1000, 1);
  for (const id of ["RUN-first", "RUN-second"]) { small.begin(id, "proposed"); small.finish(id, "completed", result()); }
  assert.equal(small.snapshot().gap, true);
  assert.equal(small.snapshot().runs.length, 1);
});

test("SQLite upserts are idempotent, survive reopening and preserve the scrape cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnc-monitor-test-"));
  let store;
  try {
    const registry = new TelemetryRegistry(() => 1000);
    registry.begin("RUN-durable-test", "proposed");
    const active = registry.snapshot();
    registry.finish("RUN-durable-test", "completed", result());
    const final = registry.snapshot();
    store = openMonitorStore(join(directory, "monitor.sqlite"));
    store.ingest(active, 1000); store.ingest(final, 2000); store.ingest(final, 3000); store.ingest(active, 4000);
    assert.equal(store.summary(range).totals.runs, 1);
    assert.equal(store.cursor().after, final.nextCursor);
    store.close(); store = openMonitorStore(join(directory, "monitor.sqlite"));
    assert.equal(store.summary(range).totals.runs, 1);
    assert.equal(store.summary(range).runs[0].status, "completed");
    assert.equal(store.cursor().instance, registry.instanceId);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("aggregates use nearest-rank percentiles, explicit error denominator, and separate source interruptions", () => {
  let now = 1000;
  const registry = new TelemetryRegistry(() => now);
  const store = openMonitorStore(":memory:");
  try {
    for (const [index, latency] of [0, 1000, 10_000].entries()) { registry.begin(`RUN-good-${index}`, "proposed"); now += 1000; registry.finish(`RUN-good-${index}`, "completed", result(latency)); }
    registry.begin("RUN-error", "managed"); registry.finish("RUN-error", "failed");
    registry.begin("RUN-cancelled", "managed"); registry.finish("RUN-cancelled", "cancelled");
    registry.begin("RUN-interrupted", "managed");
    store.ingest(registry.snapshot(), now);
    const summary = store.summary(range);
    assert.equal(summary.totals.runs, 5); assert.equal(summary.totals.errorRate, 1 / 5);
    assert.equal(summary.totals.e2eP50, 1000); assert.equal(summary.totals.e2eP95, 10_000);
    assert.equal(summary.totals.ttft, null); assert.equal(summary.totals.tokens, 0);
    assert.equal(store.summary({ ...range, mode: "proposed" }).totals.runs, 3);
    const restarted = new TelemetryRegistry(() => now + 1000);
    store.ingest(restarted.snapshot(), now + 1000);
    const after = store.summary(range);
    assert.equal(after.totals.interrupted, 1); assert.equal(after.totals.errorRate, 1 / 5);
    assert.equal(percentile([], .95), null);
    assert.equal(store.summary({ from: 900_000, to: 1_000_000 }).totals.errorRate, null);
  } finally { store.close(); }
});

test("collector persists observations without a browser, catches outages, and resumes without double counting", async () => {
  let now = 1000, offline = false;
  const source = new TelemetryRegistry(() => now);
  const store = openMonitorStore(":memory:");
  const collector = createCollector({ store, serviceUrl: "http://source.test", clock: () => now, fetchImpl: async url => {
    if (offline) throw new Error("SECRET NETWORK DETAIL");
    const params = new URL(url).searchParams;
    return Response.json(new URL(url).pathname.endsWith("health") ? { agents: [] } : source.snapshot(Number(params.get("after")), params.get("instance")));
  } });
  try {
    source.begin("RUN-collector-test", "proposed"); source.finish("RUN-collector-test", "completed", result());
    await collector.collect(); now += 5000; offline = true; await collector.collect();
    let summary = store.summary(range);
    assert.equal(summary.totals.runs, 1); assert.equal(summary.collector.latest.ok, 0);
    assert.equal(summary.collector.latest.error, "SOURCE_UNAVAILABLE");
    assert.ok(!JSON.stringify(summary).includes("SECRET"));
    now += 5000; offline = false; await collector.collect();
    summary = store.summary(range);
    assert.equal(summary.collector.latest.ok, 1); assert.equal(summary.totals.runs, 1);
  } finally { await collector.stop(); store.close(); }
});

test("independent console is read-only, serves on its own origin, and exports metrics without response text", async () => {
  const source = new TelemetryRegistry(); source.begin("RUN-server-test", "proposed"); source.finish("RUN-server-test", "completed", result());
  const monitor = await startMonitor({ port: 0, database: ":memory:", intervalMs: 1000, serviceUrl: "http://source.test", fetchImpl: async url => {
    const params = new URL(url).searchParams;
    return Response.json(new URL(url).pathname.endsWith("health") ? { agents: [] } : source.snapshot(Number(params.get("after")), params.get("instance")));
  } });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await (await fetch(`${monitor.url}/api/summary`)).json()).totals.runs === 1) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const response = await fetch(`${monitor.url}/api/summary`);
    const summary = await response.json();
    assert.equal(summary.totals.runs, 1); assert.equal(summary.config.serviceUrl, "http://source.test");
    assert.ok(!JSON.stringify(summary).includes("SECRET"));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${monitor.url}/api/summary?window=invalid`)).status, 400);
    assert.equal((await fetch(`${monitor.url}/api/summary`, { method: "POST" })).status, 405);
    const html = await (await fetch(`${monitor.url}/implementation`)).text();
    assert.match(html, /MNC.*LAB/); assert.doesNotMatch(html, /KOREA UNIVERSITY|work-request/);
    const evaluation = await (await fetch(`${monitor.url}/evaluation`)).text();
    assert.match(evaluation, /data-page="evaluation"/);
    assert.doesNotMatch(evaluation, /data-page="benchmarks"|data-page="distributed"/);
    assert.equal((await fetch(`${monitor.url}/lab-template-strip.png`)).headers.get('content-type'), 'image/png; charset=utf-8');
    const routing = await (await fetch(`${monitor.url}/api/routing-benchmark`)).json();
    assert.equal(routing.status, 'ready'); assert.equal(routing.rows.length, 4);
    assert.equal(routing.dataset.cases, 40);
    const csv = await (await fetch(`${monitor.url}/api/export.csv`)).text();
    assert.ok(csv.includes("RUN-server-test")); assert.ok(!csv.includes("SECRET"));
  } finally { await monitor.stop(); }
});

test("service telemetry endpoint enforces configured scrape token and validates its cursor", async () => {
  const previous = process.env.MONITOR_SCRAPE_TOKEN;
  process.env.MONITOR_SCRAPE_TOKEN = "test-collector-token";
  try {
    const runtime = (await import(`../dist/server/index.js?telemetry-contract=${Date.now()}`)).default;
    assert.equal((await runtime.fetch(new Request("http://localhost/api/telemetry"))).status, 401);
    const response = await runtime.fetch(new Request("http://localhost/api/telemetry", { headers: { authorization: "Bearer test-collector-token" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, "mnc-telemetry/v1");
    assert.equal((await runtime.fetch(new Request("http://localhost/api/telemetry?after=bad", { headers: { authorization: "Bearer test-collector-token" } }))).status, 400);
  } finally { if (previous === undefined) delete process.env.MONITOR_SCRAPE_TOKEN; else process.env.MONITOR_SCRAPE_TOKEN = previous; }
});
