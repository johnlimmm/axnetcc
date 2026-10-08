import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const waitUntilPromises = [];
const context = {
  waitUntil(promise) { waitUntilPromises.push(promise); },
  passThroughOnException() {},
};
const terminalStatuses = new Set(["completed", "partial_failed", "failed", "cancelled"]);
const forbiddenPublicKeys = new Set([
  "query",
  "rawQuery",
  "minimalQuery",
  "question",
  "prompt",
  "rawCorpus",
  "corpus",
  "sourceText",
]);

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("api-contract", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

async function api(runtime, path, init = {}) {
  return runtime.fetch(new Request(`http://localhost${path}`, init), environment, context);
}

function jsonRequest(body, headers = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function waitForTerminal(runtime, requestId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const response = await api(runtime, `/api/runs/${requestId}`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    latest = snapshot;
    if (terminalStatuses.has(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `run ${requestId} did not become terminal within ${timeoutMs}ms: ${JSON.stringify(latest)}`,
  );
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith(":"))
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const id = Number(lines.find((line) => line.startsWith("id:"))?.slice(3).trim());
      const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return { id, type, data: JSON.parse(data) };
    });
}

function findForbiddenKey(value, path = "response") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenPublicKeys.has(key)) return `${path}.${key}`;
    const found = findForbiddenKey(item, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function findSensitiveValue(value, secret, path = "response") {
  if (typeof value === "string") return value.includes(secret) ? path : null;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveValue(value[index], secret, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const found = findSensitiveValue(item, secret, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function assertNoSensitiveState(value) {
  for (const secret of [
    "TOPSECRET-QUERY-MNC14",
    "900101-1234567",
    "010-1234-5678",
    "private-mnc14@example.com",
    "BLUE-731",
    "010-9123-4567",
  ]) {
    const leakedAt = findSensitiveValue(value, secret);
    assert.equal(leakedAt, null, `${secret} leaked through a public run API at ${leakedAt}`);
  }
  assert.equal(findForbiddenKey(value), null, `blocked field exposed at ${findForbiddenKey(value)}`);
}

test("run API rejects malformed input and health exposes a stable no-store contract", async () => {
  const runtime = await worker();

  const malformed = await api(runtime, "/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"query":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "INVALID_JSON" });

  for (const query of ["four", "x".repeat(20_001)]) {
    const response = await api(runtime, "/api/runs", jsonRequest({ query }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_QUERY" });
  }

  const invalidKey = await api(runtime, "/api/runs", jsonRequest(
    { query: "valid request text" },
    { "idempotency-key": "short" },
  ));
  assert.equal(invalidKey.status, 400);
  assert.deepEqual(await invalidKey.json(), { error: "INVALID_IDEMPOTENCY_KEY" });

  const previousMode = process.env.EDGE_AGENT_MODE;
  const previousBaseUrl = process.env.EDGE_AGENT_BASE_URL;
  process.env.EDGE_AGENT_MODE = "remote";
  process.env.EDGE_AGENT_BASE_URL = "https://edge-health.example";
  try {
    const healthResponse = await api(runtime, "/api/health");
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    const health = await healthResponse.json();
    assert.deepEqual(Object.keys(health).sort(), [
      "agents",
      "connected",
      "edgeMode",
      "model",
      "publicEvidenceOnly",
      "scheduler",
      "status",
      "total",
    ]);
    assert.equal(health.status, "connected");
    assert.equal(health.connected, 8);
    assert.equal(health.total, 8);
    assert.equal(health.edgeMode, "remote");
    assert.equal(health.publicEvidenceOnly, false);
    assert.deepEqual(Object.keys(health.scheduler).sort(), [
      "activeCount",
      "oldestWaitMs",
      "queueDepth",
      "resourceCount",
      "resources",
    ]);
    assert.ok(health.scheduler.activeCount >= 0);
    assert.ok(health.scheduler.queueDepth >= 0);
    assert.ok(health.scheduler.oldestWaitMs >= 0);
    assert.ok(Array.isArray(health.scheduler.resources));
    assert.equal(health.agents.length, 8);
    assert.equal(new Set(health.agents.map((agent) => agent.id)).size, 8);
    assert.ok(health.agents.every((agent) =>
      agent.connected === true && agent.transport === "remote" && agent.model === "Edge managed"
    ));
  } finally {
    if (previousMode === undefined) delete process.env.EDGE_AGENT_MODE;
    else process.env.EDGE_AGENT_MODE = previousMode;
    if (previousBaseUrl === undefined) delete process.env.EDGE_AGENT_BASE_URL;
    else process.env.EDGE_AGENT_BASE_URL = previousBaseUrl;
  }
});

test("async run status, SSE resume, and idempotency remain raw-free", { timeout: 30_000 }, async () => {
  const runtime = await worker();
  const waitUntilCountBeforeStart = waitUntilPromises.length;
  const idempotencyKey = `mnc14-api-${process.pid}-${Date.now()}`;
  const body = {
    query: "TOPSECRET-QUERY-MNC14 주민등록번호 900101-1234567 연락처 010-1234-5678 private-mnc14@example.com 내부 장애 대응 검토",
    mode: "proposed",
  };
  const startedResponse = await api(runtime, "/api/runs", jsonRequest(body, {
    "idempotency-key": idempotencyKey,
  }));
  assert.equal(startedResponse.status, 202);
  assert.equal(startedResponse.headers.get("cache-control"), "no-store");
  const started = await startedResponse.json();
  assert.match(started.requestId, /^RUN-/);
  assert.equal(started.reused, false);
  assert.equal(started.statusUrl, `/api/runs/${started.requestId}`);
  assert.equal(started.eventsUrl, `/api/runs/${started.requestId}/events`);
  assert.ok(waitUntilPromises.length > waitUntilCountBeforeStart);

  const reusedResponse = await api(runtime, "/api/runs", jsonRequest(body, {
    "idempotency-key": idempotencyKey,
  }));
  assert.equal(reusedResponse.status, 202);
  const reused = await reusedResponse.json();
  assert.equal(reused.requestId, started.requestId);
  assert.equal(reused.reused, true);

  const conflict = await api(runtime, "/api/runs", jsonRequest(
    { ...body, query: "different valid request text" },
    { "idempotency-key": idempotencyKey },
  ));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "IDEMPOTENCY_CONFLICT" });

  const terminal = await waitForTerminal(runtime, started.requestId);
  assert.ok(terminalStatuses.has(terminal.status));
  assert.equal(terminal.requestId, started.requestId);
  assert.equal(terminal.progress.remainingCount, 0);
  assert.equal(terminal.progress.terminalCount, terminal.progress.totalCount);
  assertNoSensitiveState(terminal);

  const eventsResponse = await api(runtime, `/api/runs/${started.requestId}/events`);
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(eventsResponse.headers.get("x-accel-buffering"), "no");
  const events = parseSse(await eventsResponse.text());
  assert.ok(events.length >= 1);
  assert.deepEqual(events.map((event) => event.id), events.map((_, index) => index + 1));
  assert.ok(["completed", "failed", "cancelled"].includes(events.at(-1).type));
  assertNoSensitiveState(events);

  const resumedResponse = await api(
    runtime,
    `/api/runs/${started.requestId}/events?after=${Math.max(0, events.at(-1).id - 1)}`,
  );
  const resumed = parseSse(await resumedResponse.text());
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].id, events.at(-1).id);
  assertNoSensitiveState(resumed);

  const listResponse = await api(runtime, "/api/runs");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.headers.get("cache-control"), "no-store");
  const list = await listResponse.json();
  assert.ok(list.total >= 1);
  assert.equal(typeof list.active, "number");
  assertNoSensitiveState(list);
});

test("run cancellation and missing-resource handling are idempotent", { timeout: 20_000 }, async () => {
  let markStarted;
  const inferenceStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  const server = createServer((request) => {
    request.resume();
    markStarted();
    // Deliberately keep the response open until cancellation aborts the client.
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.LOCAL_LLM_MODEL = "mnc14-cancel-test";
  process.env.LOCAL_LLM_TIMEOUT_MS = "10000";
  process.env.EDGE_AGENT_MODE = "local";
  try {
    const runtime = await worker();
    const startedResponse = await api(runtime, "/api/runs", jsonRequest({
      query: "TOPSECRET-QUERY-MNC14 cancel AI system performance review 900101-1234567",
      mode: "centralized",
    }));
    assert.equal(startedResponse.status, 202);
    const started = await startedResponse.json();
    let inferenceTimeout;
    try {
      await Promise.race([
        inferenceStarted,
        new Promise((_, reject) => {
          inferenceTimeout = setTimeout(
            () => reject(new Error("inference did not start")),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(inferenceTimeout);
    }

    const runningHealthResponse = await api(runtime, "/api/health");
    assert.equal(runningHealthResponse.status, 200);
    const runningHealth = await runningHealthResponse.json();
    assert.ok(runningHealth.scheduler.activeCount >= 1);
    const activeResources = runningHealth.scheduler.resources.filter((resource) => resource.activeCount > 0);
    assert.ok(activeResources.length >= 1);
    assert.ok(activeResources.some((resource) => resource.running.some((task) =>
      task.taskKind === "central-integration" &&
      task.agentId === "tech" &&
      Number.isFinite(task.runningForMs)
    )));
    assert.equal(findForbiddenKey(runningHealth), null);
    assert.equal(findSensitiveValue(runningHealth, "TOPSECRET-QUERY-MNC14"), null);

    const firstCancel = await api(runtime, `/api/runs/${started.requestId}`, { method: "DELETE" });
    assert.equal(firstCancel.status, 200);
    const cancelled = await firstCancel.json();
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.errorCode, "CANCELLED");
    assertNoSensitiveState(cancelled);

    const repeatedCancel = await api(runtime, `/api/runs/${started.requestId}`, { method: "DELETE" });
    assert.equal(repeatedCancel.status, 200);
    assert.equal((await repeatedCancel.json()).status, "cancelled");

    const eventsResponse = await api(runtime, `/api/runs/${started.requestId}/events`);
    const events = parseSse(await eventsResponse.text());
    assert.equal(events.filter((event) => event.type === "cancelled").length, 1);
    assert.equal(events.at(-1).type, "cancelled");
    assertNoSensitiveState(events);

    for (const [method, suffix] of [
      ["GET", ""],
      ["DELETE", ""],
      ["GET", "/events"],
    ]) {
      const response = await api(runtime, `/api/runs/RUN-NOT-FOUND${suffix}`, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "RUN_NOT_FOUND" });
    }
  } finally {
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.LOCAL_LLM_TIMEOUT_MS;
    delete process.env.EDGE_AGENT_MODE;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
