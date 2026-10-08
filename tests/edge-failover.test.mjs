import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { executeEdgeAgent } = await import("../lib/edge-agent-client.ts");
const { projectEdgeAgentResponseForCore } = await import("../lib/edge-core-contract.ts");
const { getDistributedRun, recordEdgeAttempt, recordInferenceStage } = await import("../lib/distributed-metrics.ts");
const { scheduleAgentTask, executionSchedulerSnapshot } = await import("../lib/execution-scheduler.ts");
const { requestCoordinator } = await import("../lib/request-coordinator.ts");
const { residualComputeRisk } = await import("../scripts/benchmark-distributed-demo.mjs");
const { projectDistributedTelemetry } = await import("../lib/distributed-telemetry.ts");
let sequence = 0;

for(const proof of [true,false,undefined,"true"]) test(`failed Edge provider completion proof is strict and nonretrying: ${String(proof)}`,()=>fixture(async()=>{
  const req=request();let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:"inference-invalid",code:"inference-invalid",requestId:req.requestId,agentId:req.agentId,usage:{model:"test-model",promptTokens:7,completionTokens:3,...(proof===undefined?{}:{providerFinalObserved:proof})}}),{status:503,headers:goodResponse(req).headers});};
  await assert.rejects(executeEdgeAgent(req));assert.equal(calls,1);
  const projected=projectDistributedTelemetry(getDistributedRun(req.traceId),req.traceId);
  assert.equal(projected.attempts[0].providerFinalObserved,proof===true);
  if(proof===true)assert.equal(projected.attempts[0].reasonCode,"inference-invalid");
  assert.equal(residualComputeRisk({distributed:projected}),proof!==true);
}));

test("foreign Edge identity cannot provide provider completion proof",()=>fixture(async()=>{
  const req=request();const headers=new Headers(goodResponse(req).headers);headers.set("x-edge-node-id","foreign");
  globalThis.fetch=async()=>new Response(JSON.stringify({error:"inference-invalid",code:"inference-invalid",requestId:req.requestId,agentId:req.agentId,usage:{model:"test-model",promptTokens:7,completionTokens:3,providerFinalObserved:true}}),{status:503,headers});
  await assert.rejects(executeEdgeAgent(req));const run=getDistributedRun(req.traceId);assert.equal(run.attempts[0].providerFinalObserved,false);assert.equal(residualComputeRisk({distributed:run}),true);
}));

test("legacy unconfigured manifest cannot upgrade provider completion proof",()=>fixture(async()=>{
  for(const key of ["BACKUP_BASE_URL","NODE_ID","REPLICA_ID"])delete process.env[`EDGE_AGENT_TECH_${key}`];
  delete process.env.DEMO_REQUIRE_LLM;
  const req=request();
  globalThis.fetch=async()=>new Response(JSON.stringify({error:"inference-invalid",code:"inference-invalid",requestId:req.requestId,agentId:req.agentId,usage:{model:"test-model",promptTokens:7,completionTokens:3,providerFinalObserved:true}}),{status:503,headers:goodResponse(req).headers});
  await assert.rejects(executeEdgeAgent(req));const run=getDistributedRun(req.traceId);assert.equal(run.attempts[0].providerFinalObserved,false);assert.equal(residualComputeRisk({distributed:run}),true);
}));
function request() { const id = `FAILOVER-${++sequence}`; return { version: "1", requestId: `${id}-tech`, traceId: id, agentId: "tech", purpose: "orchestration", minimalQuery: "Public architecture evidence", limits: { topK: 3, deadlineMs: 2000 } }; }
function goodResponse(req, role = "primary", overrides = {}) {
  const projected = projectEdgeAgentResponseForCore({ version: "1", requestId: req.requestId, agentId: req.agentId, status: "completed",
    answer: { text: "Public evidence answer [PUB-1]", classification: "public", citations: ["PUB-1"] },
    evidence: [{ referenceId: "PUB-1", classification: "public", disclosure: "excerpt", title: "Public", section: "Architecture", excerpt: "Public reference", retrievalScore: 1 }],
    policy: { decisionId: "POL-TEST", outcome: "allow", effectiveClasses: ["public"], highestEvidenceClassification: "public", redactionCount: 0, blockedCount: 0 },
    metrics: { backend: "ollama", answerSource: "local-llm", model: "test-model", evidenceCount: 1, sourceBytesProcessed: 100, egressBytes: 0, latencyMs: 2, ttftMs: 1, tpotMs: 1, promptTokens: 12, completionTokens: 5, corpusChunks: 1 },
    audit: { eventId: "AUD-TEST", recordedAt: "2026-09-23T00:00:00.000Z", policyVersion: "edge-rag-v1" },
  }, "http");
  return new Response(JSON.stringify(projected), { headers: { "x-edge-node-id": role, "x-edge-replica-id": `${role}-replica`, "x-edge-corpus-version": "public-v1", "x-edge-model-version": "model-v1", ...overrides } });
}
async function fixture(fn) {
  const saved = { ...process.env }; const fetch = globalThis.fetch;
  Object.assign(process.env, { NODE_ENV: "test", EDGE_AGENT_MODE: "remote", EDGE_AGENT_TECH_BASE_URL: "https://primary.test/tech", EDGE_AGENT_TECH_TOKEN: "primary-token", EDGE_AGENT_TECH_NODE_ID: "primary", EDGE_AGENT_TECH_REPLICA_ID: "primary-replica", EDGE_AGENT_TECH_BACKUP_BASE_URL: "https://backup.test/tech", EDGE_AGENT_TECH_BACKUP_TOKEN: "backup-token", EDGE_AGENT_TECH_BACKUP_NODE_ID: "backup", EDGE_AGENT_TECH_BACKUP_REPLICA_ID: "backup-replica", EDGE_EXPECTED_CORPUS_VERSION: "public-v1", EDGE_EXPECTED_MODEL_VERSION: "model-v1", EDGE_AGENT_TIMEOUT_MS: "1000" });
  try { await fn(); } finally { globalThis.fetch = fetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
}
test("primary success consumes one physical attempt, measured tokens and actual payload bytes", () => fixture(async () => {
  const req = request(); let calls = 0;
  globalThis.fetch = async () => { calls++; return goodResponse(req); };
  await executeEdgeAgent(req);
  const run = getDistributedRun(req.traceId);
  assert.equal(calls, 1); assert.equal(run.attempts[0].adopted, true);
  assert.equal(run.totals.promptTokens, 12); assert.equal(run.totals.completionTokens, 5);
  assert.ok(run.totals.responseBytesReceived > 100); assert.ok(run.totals.requestBytesPrepared > 0);
}));
test("connectivity failure adopts trusted backup without terminalizing logical parent early", () => fixture(async () => {
  const req = request(); let calls = 0;
  requestCoordinator.planRequest({ requestId: req.traceId, mode: "parallel", selectedAgents: ["tech"] });
  globalThis.fetch = async () => {
    calls++;
    assert.equal(requestCoordinator.getTask(`${req.traceId}_tech`).status, "running");
    if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return goodResponse(req, "backup");
  };
  await scheduleAgentTask({ requestId: req.traceId, taskId: `${req.traceId}_tech`, agentId: "tech", stage: "test", execute: signal => executeEdgeAgent(req, signal) });
  assert.equal(requestCoordinator.getTask(`${req.traceId}_tech`).status, "succeeded");
  const run = getDistributedRun(req.traceId);
  assert.equal(calls, 2); assert.deepEqual(run.attempts.map(a => a.adopted), [false, true]);
  assert.equal(run.totals.promptTokens, null); assert.equal(run.totals.knownPromptTokens, 12);
}));
for (const [status, code, retries] of [[503, "inference-unavailable", true], [503, "edge-unavailable", true], [503, "inference-invalid", false], [503, "unknown", false], [401, "inference-unavailable", false], [403, "edge-unavailable", false], [400, "edge-unavailable", false], [429, "edge-unavailable", false], [502, "edge-unavailable", true], [504, "edge-unavailable", true]]) {
  test(`HTTP ${status}/${code} retry=${retries}`, () => fixture(async () => {
    const req = request(); let calls = 0;
    globalThis.fetch = async () => ++calls === 1 ? new Response(JSON.stringify({ code }), { status }) : goodResponse(req, "backup");
    if (retries) await executeEdgeAgent(req); else await assert.rejects(executeEdgeAgent(req));
    assert.equal(calls, retries ? 2 : 1);
  }));
}
for (const cause of [new Error("generic"), new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } }), new TypeError("redirect")]) {
  test(`unknown/TLS/redirect error never retries: ${cause.message}`, () => fixture(async () => {
    const req = request(); let calls = 0; globalThis.fetch = async () => { calls++; throw cause; };
    await assert.rejects(executeEdgeAgent(req)); assert.equal(calls, 1);
  }));
}
test("trusted identity mismatch and malformed contract never retry", () => fixture(async () => {
  for (const invalid of [req => goodResponse(req, "primary", { "x-edge-corpus-version": "wrong" }), () => new Response("{}")]) {
    let calls = 0; const req = request(); globalThis.fetch = async () => { calls++; return invalid(req); };
    await assert.rejects(executeEdgeAgent(req)); assert.equal(calls, 1);
  }
}));
test("caller cancellation records failure bytes and prevents backup", () => fixture(async () => {
  const req = request(); const controller = new AbortController(); let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode("partial"));
      options.signal.addEventListener("abort", () => stream.error(options.signal.reason), { once: true });
      setTimeout(() => controller.abort(), 10);
    } }));
  };
  await assert.rejects(executeEdgeAgent(req, controller.signal));
  const attempt = getDistributedRun(req.traceId).attempts[0];
  assert.equal(calls, 1); assert.equal(attempt.status, "cancelled"); assert.equal(attempt.responseBytesReceived, 7);
}));
test("late primary never adopted after timeout; backup independent capacity succeeds", () => fixture(async () => {
  process.env.EDGE_AGENT_TIMEOUT_MS = "150";
  const req = request(); let calls = 0;
  globalThis.fetch = async () => { calls++; if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 240)); return goodResponse(req); } return goodResponse(req, "backup"); };
  await executeEdgeAgent(req);
  await new Promise(resolve => setTimeout(resolve, 120));
  const run = getDistributedRun(req.traceId);
  assert.deepEqual(run.attempts.map(a => a.adopted), [false, true]); assert.equal(run.attempts[0].reasonCode, "attempt-timeout");
  assert.equal(executionSchedulerSnapshot().length, 0);
}));
test("shared backup node capacity stays one across concurrent logical runs", () => fixture(async () => {
  let active = 0; let maximum = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes("primary")) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return goodResponse(JSON.parse(options.body), "backup");
  };
  await Promise.all([executeEdgeAgent(request()), executeEdgeAgent(request()), executeEdgeAgent(request())]);
  assert.equal(maximum, 1);
}));
test("complete metric totals stay null with unknown attempts; dedup and stages separate", () => {
  const id = `METRICS-${++sequence}`;
  const attempt = { attemptId: "one", requestId: id, agentId: "tech", nodeId: "primary", replicaId: "replica", role: "primary", startedAt: 1, completedAt: 2, elapsedMs: 1, queueWaitMs: 0, requestBytesPrepared: 10, responseBytesReceived: 4, status: "failed", reasonCode: "attempt-timeout", backend: null, model: null, promptTokens: null, completionTokens: null, usageStatus: "unknown", adopted: false };
  recordEdgeAttempt(id, attempt); recordEdgeAttempt(id, attempt);
  recordInferenceStage(id, "synthesis", { backend: "ollama", model: "test", promptTokens: 9, completionTokens: 3 });
  const run = getDistributedRun(id); assert.equal(run.attempts.length, 1); assert.equal(run.totals.promptTokens, null); assert.equal(run.totals.knownPromptTokens, 9); assert.equal(run.totals.unknownCount, 1);
});

test("pre-aborted callers and invalid backup configuration make no network calls", () => fixture(async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("unexpected"); };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executeEdgeAgent(request(), controller.signal));
  process.env.EDGE_AGENT_TECH_BACKUP_NODE_ID = "primary";
  await assert.rejects(executeEdgeAgent(request()), /distinct/);
  assert.equal(calls, 0);
}));
test("both down fails after exactly two attempts and never claims recovery", () => fixture(async () => {
  const req = request(); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("offline", { cause: { code: "ECONNREFUSED" } }); };
  await assert.rejects(executeEdgeAgent(req));
  assert.equal(calls, 2); assert.ok(getDistributedRun(req.traceId).attempts.every(item => !item.adopted));
}));
test("whole Agent budget expires including physical queue, without dispatching queued requests", () => fixture(async () => {
  process.env.EDGE_AGENT_BUDGET_MS = "120";
  const blocking = request(); const queued = request(); let primaryCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes("backup")) return goodResponse(JSON.parse(options.body), "backup");
    primaryCalls++;
    await new Promise(resolve => setTimeout(resolve, 250));
    return goodResponse(JSON.parse(options.body));
  };
  const pending = executeEdgeAgent(blocking);
  requestCoordinator.planRequest({ requestId: queued.traceId, mode: "parallel", selectedAgents: ["tech"] });
  await assert.rejects(scheduleAgentTask({ requestId: queued.traceId, taskId: `${queued.traceId}_tech`, agentId: "tech", stage: "test", execute: signal => executeEdgeAgent(queued, signal) }));
  assert.equal(primaryCalls, 1);
  const run = getDistributedRun(queued.traceId);
  assert.ok(run.attempts.every(item => !item.adopted));
  assert.ok(run.attempts.every(item => item.requestBytesPrepared === 0));
  await pending;
}));
test("legacy primary-only remote configuration does not require new manifest", () => fixture(async () => {
  for (const key of ["BACKUP_BASE_URL", "NODE_ID", "REPLICA_ID"]) delete process.env[`EDGE_AGENT_TECH_${key}`];
  const req = request(); let calls = 0; globalThis.fetch = async () => { calls++; return goodResponse(req); };
  await executeEdgeAgent(req); assert.equal(calls, 1);
}));

test("failed trusted Edge usage envelope preserves finalized cost but never adopts rejected output", () => fixture(async () => {
  const req = request(); let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "inference-invalid", code: "inference-invalid", requestId: req.requestId, agentId: req.agentId, usage: { model: "test-model", promptTokens: 31, completionTokens: 4 } }), { status: 503, headers: goodResponse(req).headers });
  };
  await assert.rejects(executeEdgeAgent(req));
  const run = getDistributedRun(req.traceId); assert.equal(calls, 1); assert.equal(run.totals.promptTokens, 31); assert.equal(run.totals.completionTokens, 4); assert.equal(run.attempts[0].adopted, false);
}));
test("untrusted failed usage envelope cannot supply counters or trigger backup", () => fixture(async () => {
  const req = request(); let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "inference-unavailable", code: "inference-unavailable", requestId: "WRONG", agentId: req.agentId, usage: { model: "test-model", promptTokens: 31, completionTokens: 4 } }), { status: 503, headers: goodResponse(req).headers });
  };
  await assert.rejects(executeEdgeAgent(req));
  assert.equal(calls, 1); assert.equal(getDistributedRun(req.traceId).totals.promptTokens, null);
}));
test("logical configuration failure is failed rather than cancelled before physical dispatch", () => fixture(async () => {
  const req = request(); requestCoordinator.planRequest({ requestId: req.traceId, mode: "parallel", selectedAgents: ["tech"] });
  process.env.EDGE_AGENT_TECH_BACKUP_NODE_ID = "primary";
  await assert.rejects(scheduleAgentTask({ requestId: req.traceId, taskId: `${req.traceId}_tech`, agentId: "tech", stage: "test", execute: signal => executeEdgeAgent(req, signal) }));
  assert.equal(requestCoordinator.getTask(`${req.traceId}_tech`).status, "failed");
}));

test("distributed numeric boundary rejects corrupt bytes and retains invalid usage as unknown", () => {
  const id = `METRICS-BOUNDARY-${++sequence}`;
  const attempt = { attemptId: "bounded-attempt", requestId: id, agentId: "tech", nodeId: "primary", replicaId: "replica", role: "primary", startedAt: 1, completedAt: 2, elapsedMs: 1, queueWaitMs: 0, requestBytesPrepared: 10, responseBytesReceived: 4, status: "failed", reasonCode: "attempt-timeout", backend: null, model: null, promptTokens: null, completionTokens: null, usageStatus: "unknown", adopted: false };
  assert.throws(() => recordEdgeAttempt(id, { ...attempt, responseBytesReceived: NaN }), /Invalid distributed/);
  assert.throws(() => recordEdgeAttempt(id, { ...attempt, requestBytesPrepared: -1 }), /Invalid distributed/);
  recordEdgeAttempt(id, { ...attempt, promptTokens: NaN, completionTokens: -1, usageStatus: "measured", rawError: "MUST-NOT-LEAK" });
  const run = getDistributedRun(id);
  assert.equal(run.attempts[0].requestBytesPrepared, 10); assert.equal(run.attempts[0].responseBytesReceived, 4);
  assert.equal(run.attempts[0].usageStatus, "unknown"); assert.equal(run.totals.promptTokens, null);
  assert.equal(JSON.stringify(run).includes("MUST-NOT-LEAK"), false);
});
