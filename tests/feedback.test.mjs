import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleFeedbackRequest, parseFeedback, summarizeFeedback } from "../lib/feedback.ts";
import { fileFeedbackStore, databaseFeedbackStore } from "../lib/feedback-store.ts";
import { metricsCsv } from "../lib/metrics-csv.ts";
import { startMonitor } from "../monitor/server.mjs";

const input = () => ({ id: crypto.randomUUID(), runId: "RUN-feedback-test", rating: 4, categories: ["latency"], comment: "응답이 유용합니다. tester@example.com 010-1234-5678" });
const request = (body, extra = {}) => new Request("http://localhost/api/feedback", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

test("feedback validates untrusted payloads and redacts identifiers before persistence", () => {
  for (const bad of [null, [], {}, { ...input(), rating: 0 }, { ...input(), rating: 1.5 }, { ...input(), rating: "5" }, { ...input(), categories: ["__proto__"] }, { ...input(), comment: "a".repeat(2001) }, { ...input(), id: "../../bad" }, { ...input(), runId: "arbitrary" }]) assert.equal(parseFeedback(bad), null);
  const parsed = parseFeedback({ ...input(), query: "Never persist this", categories: ["latency", "latency"] });
  assert.deepEqual(parsed.categories, ["latency"]);
  assert.ok(!parsed.comment.includes("tester@example.com"));
  assert.ok(!parsed.comment.includes("010-1234-5678"));
  assert.equal("query" in parsed, false);
});

test("Node feedback survives a new store instance and concurrent retry creates one receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnc-feedback-"));
  try {
    const body = input();
    const responses = await Promise.all(Array.from({ length: 6 }, () => handleFeedbackRequest(request(body), fileFeedbackStore(directory))));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.ok(responses.every((response) => [200, 201].includes(response.status)));
    const persisted = await fileFeedbackStore(directory).list();
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].rating, 4);
    assert.ok(!persisted[0].comment.includes("tester@example.com"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("D1 adapter executes its SQL and preserves receipt uniqueness", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; }, async run() { const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; } };
  } };
  try {
    const record = { ...parseFeedback(input()), createdAt: new Date().toISOString() };
    assert.equal((await databaseFeedbackStore(db).save(record)).created, true);
    assert.equal((await databaseFeedbackStore(db).save(record)).created, false);
    assert.deepEqual(await databaseFeedbackStore(db).list(), [record]);
  } finally { sqlite.close(); }
});

test("feedback API rejects oversized and cross-origin writes and reports storage failure honestly", async () => {
  const unavailable = { async save() { throw new Error("disk full"); }, async list() { throw new Error("offline"); } };
  assert.equal((await handleFeedbackRequest(request(input()), unavailable)).status, 503);
  const publicRead = await handleFeedbackRequest(new Request("http://localhost/api/feedback"), unavailable);
  assert.equal(publicRead.status, 405);
  assert.equal(publicRead.headers.get("allow"), "POST");
  assert.equal((await handleFeedbackRequest(request(input(), { origin: "https://other.example" }), unavailable)).status, 403);
  assert.equal((await handleFeedbackRequest(request({ ...input(), comment: "a".repeat(20_000) }), unavailable)).status, 413);
  assert.equal((await handleFeedbackRequest(request(null), unavailable)).status, 400);
  const invalidJson = new Request("http://localhost/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  assert.equal((await handleFeedbackRequest(invalidJson, unavailable)).status, 400);
});

test("feedback aggregate does not invent a score for no votes; CSV preserves unknown and zero", () => {
  assert.equal(summarizeFeedback([]).averageRating, null);
  const record = { ...parseFeedback(input()), createdAt: "2026-09-08T00:00:00Z" };
  const summary = summarizeFeedback([record, { ...record, id: crypto.randomUUID(), rating: 2 }]);
  assert.equal(summary.averageRating, 3);
  assert.equal(summary.categories.latency, 2);
  const csv = metricsCsv([["E2E", 0, null], ["=HYPERLINK(x)", "line\nquote\"", "ms"]]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"E2E","0",""'));
  assert.ok(csv.includes('"\'=HYPERLINK(x)"'));
  assert.ok(csv.includes('"line\nquote"""'));
});

test("built feedback API supports Node requests without Cloudflare environment bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnc-feedback-api-"));
  const previous = process.env.FEEDBACK_DIRECTORY;
  process.env.FEEDBACK_DIRECTORY = directory;
  try {
    const runtime = (await import(`../dist/server/index.js?feedback-contract=${Date.now()}`)).default;
    const body = input();
    const response = await runtime.fetch(request(body));
    assert.equal(response.status, 201);
    const repeated = await runtime.fetch(request(body));
    assert.equal(repeated.status, 200);
    const list = await runtime.fetch(new Request("http://localhost/api/feedback"));
    assert.equal(list.status, 405);
    const summary = summarizeFeedback(await fileFeedbackStore(directory).list());
    assert.equal(summary.total, 1);
    assert.equal(summary.averageRating, 4);
    assert.ok(!JSON.stringify(summary).includes("tester@example.com"));
    assert.equal(list.headers.get("cache-control"), "no-store");
  } finally {
    if (previous === undefined) delete process.env.FEEDBACK_DIRECTORY;
    else process.env.FEEDBACK_DIRECTORY = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("feedback submitted to the service is readable only through the independent console", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnc-feedback-console-"));
  const store = fileFeedbackStore(directory);
  const body = input();
  let monitor;
  try {
    assert.equal((await handleFeedbackRequest(request(body), store)).status, 201);
    monitor = await startMonitor({ port: 0, database: ":memory:", feedbackStore: fileFeedbackStore(directory), fetchImpl: async () => { throw new Error("offline"); } });
    const response = await fetch(monitor.url + "/api/feedback");
    const summary = await response.json();
    assert.equal(summary.total, 1);
    assert.equal(summary.recent[0].id, body.id);
    assert.equal(summary.ratings[4], 1);
    assert.ok(!JSON.stringify(summary).includes("tester@example.com"));
    assert.equal((await fetch(monitor.url + "/api/feedback", { method: "POST" })).status, 405);
    assert.equal((await fetch(monitor.url + "/feedback")).status, 200);
    assert.equal((await fetch(monitor.url + "/feedback.css")).status, 200);
    assert.equal((await handleFeedbackRequest(new Request("http://localhost/api/feedback"), store)).status, 405);
  } finally { await monitor?.stop(); await rm(directory, { recursive: true, force: true }); }
});
