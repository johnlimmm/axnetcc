import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { createGatewayHandlers } from "../scripts/demo-gateway.mjs";
import { createInferenceProxyHandler } from "../scripts/demo-inference-proxy.mjs";
import { campaign, runSample, summarize, percentile, residualComputeRisk, cleanupCampaign, installCampaignInterrupts } from "../scripts/benchmark-distributed-demo.mjs";
const token = "test-only-auth-token";
test("Core final EOF proof exempts only failed invalid rendering, never counters/transients/cancellation",()=>{
  const base={backend:"deterministic",status:"failed",failureCode:"invalid-response",providerFinalObserved:true,promptTokens:7,completionTokens:3};
  const sample=call=>({distributed:{attempts:[],calls:[call],stages:[{backend:"deterministic"}]}});
  assert.equal(residualComputeRisk(sample(base)),false);
  for(const change of [{providerFinalObserved:false},{providerFinalObserved:undefined},{providerFinalObserved:"true"},{status:"cancelled"},{failureCode:"timeout"},{failureCode:"provider-error"}])assert.equal(residualComputeRisk(sample({...base,...change})),true);
  assert.equal(residualComputeRisk({...sample(base),cancellationRequested:true}),true);
});
async function server(handler) { const value = http.createServer(handler); value.listen(0, "127.0.0.1"); await once(value, "listening"); return { value, port: value.address().port, url: `http://127.0.0.1:${value.address().port}`, close() { value.closeAllConnections(); value.close(); } }; }
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-edge-agent-id": "tech" };
const post = (url, body, extra = {}) => fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
async function gatewayFixture(fn, faultsEnabled = true) {
  const upstream = await server((req, res) => { assert.equal(req.headers["x-forwarded-proto"], "https"); res.writeHead(200, { "content-type": "application/json", "x-edge-node-id": "trusted-primary", "x-edge-replica-id": "trusted-replica", "x-edge-corpus-version": "public-v1", "x-edge-model-version": "model-v1" }); res.end('{"answer":"public"}'); });
  const handlers = createGatewayHandlers({ routes: [{ role: "primary", agentId: "tech", port: upstream.port, token }], controlToken: token, faultsEnabled });
  const data = await server(handlers.data); const control = await server(handlers.control);
  try { await fn(data, control); } finally { handlers.close(); data.close(); control.close(); upstream.close(); }
}
test("isolated gateway authenticates fixed routes and preserves trusted identity", () => gatewayFixture(async data => {
  assert.equal((await fetch(`${data.url}/primary/tech/api/edge/agent`, { method: "POST" })).status, 401);
  assert.equal((await post(`${data.url}/http://other/api/edge/agent`, {})).status, 404);
  assert.equal((await post(`${data.url}/primary/tech/api/edge/agent`, {}, { "x-edge-agent-id": "security" })).status, 403);
  const response = await post(`${data.url}/primary/tech/api/edge/agent`, {});
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-edge-node-id"), "trusted-primary"); assert.equal(response.headers.get("x-edge-model-version"), "model-v1");
  assert.deepEqual(await response.json(), { answer: "public" });
}));
test("gateway controls disabled by default and reject browser-origin writes", async () => {
  await gatewayFixture(async (_data, control) => {
    assert.equal((await post(`${control.url}/fault`, { scenario: "primary-down", ttlMs: 100 })).status, 403);
  }, false);
  await gatewayFixture(async (_data, control) => {
    assert.equal((await post(`${control.url}/fault`, { scenario: "primary-down", ttlMs: 100 }, { origin: "https://untrusted.test" })).status, 400);
    assert.equal((await post(`${control.url}/fault`, { scenario: "shell", command: "never" })).status, 400);
    assert.equal((await post(`${control.url}/fault`, { scenario: "primary-down", ttlMs: 300001 })).status, 400);
  });
});
test("route faults return typed503 and automatically restore on TTL", () => gatewayFixture(async (data, control) => {
  assert.equal((await post(`${control.url}/fault`, { scenario: "primary-down", agentId: "tech", ttlMs: 30 })).status, 200);
  const unavailable = await post(`${data.url}/primary/tech/api/edge/agent`, {}); assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), { code: "edge-unavailable" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await post(`${data.url}/primary/tech/api/edge/agent`, {})).status, 200);
}));
test("inference-only failure leaves readiness alive and forwards exact finalized NDJSON", async () => {
  const body = '{"message":{"content":"public"},"done":false}\n{"done":true,"prompt_eval_count":7,"eval_count":2}';
  const upstream = await server((req, res) => { res.setHeader("content-type", "application/x-ndjson"); res.write(body.slice(0, 13)); res.end(body.slice(13)); });
  const handler = createInferenceProxyHandler({ upstreamPort: upstream.port, controlToken: token, faultsEnabled: true });
  const proxy = await server(handler);
  try {
    assert.equal(await (await post(`${proxy.url}/api/chat`, {})).text(), body);
    assert.equal((await post(`${proxy.url}/__control`, { unavailable: true, ttlMs: 100 })).status, 200);
    const fault = await post(`${proxy.url}/api/chat`, {}); assert.equal(fault.status, 503); assert.deepEqual(await fault.json(), { code: "inference-unavailable" });
    assert.equal((await fetch(`${proxy.url}/api/version`)).status, 200);
    assert.equal((await fetch(`${proxy.url}/api/delete`, { method: "DELETE" })).status, 404);
    assert.equal((await post(`${proxy.url}/__control`, { unavailable: false })).status, 200);
    assert.equal(await (await post(`${proxy.url}/api/chat`, {})).text(), body);
  } finally { handler.close(); proxy.close(); upstream.close(); }
});
const fixture = { id: "public-test", query: "Synthetic public test", expectedTerms: ["public"], targetAgent: "tech" };
const config = { inferenceControlUrl: "http://127.0.0.1:25199", inferenceControlToken: token, coreUrl: "http://127.0.0.1:35101", operatorToken: token, timeoutMs: 100, drainTimeoutMs: 500 };
const response = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
test("mock-only benchmark timeout explicitly cancels, verifies drain and retains unknown cost", async () => {
  let now = 0; let cancelled = false; let deletes = 0;
  const sample = await runSample(config, fixture, "healthy-backup-enabled", {
    now: () => now, wait: async milliseconds => { now += milliseconds; },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/runs")) return response({ requestId: "RUN-test" });
      if (options.method === "DELETE") { cancelled = true; deletes++; return response({}); }
      if (url.endsWith("/api/runs/RUN-test")) return response({ status: cancelled ? "cancelled" : "running", executionSettled: cancelled });
      if (url.endsWith("/__health")) return response({ activeRequests: 0 });
      if (url.endsWith("/api/health")) return response({ scheduler: { activeCount: 0, queueDepth: 0 } });
      return response({ runs: [{ runId: "RUN-test", distributed: null }], instanceId: "test-only" });
    },
  });
  assert.equal(deletes, 1); assert.equal(sample.drained, true); assert.equal(sample.uncertain, false); assert.equal(sample.reasonCode, "sample-timeout"); assert.equal(sample.distributed, null);
  const summary = summarize([sample])["healthy-backup-enabled"];
  assert.equal(summary.realSuccessRate, 0); assert.equal(summary.unknownCount, 1); assert.equal(summary.completePromptTokens, null);
});
test("mock-only benchmark stops safely when cancelled work never drains", async () => {
  let now = 0;
  const sample = await runSample(config, fixture, "caller-cancelled", {
    now: () => now, wait: async milliseconds => { now += milliseconds; },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/runs")) return response({ requestId: "RUN-test" });
      if (options.method === "DELETE") return response({});
      if (url.endsWith("/api/health")) return response({ scheduler: { activeCount: 1, queueDepth: 0 } });
      return response({ status: "cancelled", executionSettled: false });
    },
  });
  assert.equal(sample.uncertain, true); assert.equal(sample.drained, false);
});
test("benchmark baseline remains explicitly skipped without separate config; null percentiles never become zero", async () => {
  const sample = await runSample(config, fixture, "healthy-backup-disabled"); assert.equal(sample.skipped, true);
  assert.equal(percentile([null, undefined, NaN], .95), null); assert.equal(percentile([1, 3, 2], .95), 3);
});

test("proxy health tracks streaming upstream until cancellation closes transport", async () => {
  const upstream = await server((_req, res) => { res.writeHead(200, { "content-type": "application/x-ndjson" }); res.write('{"message":{"content":"partial"}}\n'); });
  const handler = createInferenceProxyHandler({ upstreamPort: upstream.port, controlToken: token }); const proxy = await server(handler);
  try {
    const controller = new AbortController();
    const streaming = await fetch(`${proxy.url}/api/chat`, { method: "POST", headers, body: "{}", signal: controller.signal });
    const health = () => fetch(`${proxy.url}/__health`, { headers }).then(value => value.json());
    assert.equal((await health()).activeRequests, 1);
    controller.abort(); await assert.rejects(streaming.text());
    let state; for (let i = 0; i < 30; i++) { state = await health(); if (state.activeRequests === 0) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(state.activeRequests, 0); assert.match(state.drainSemantics, /not-proof-of-compute/);
  } finally { handler.close(); proxy.close(); upstream.close(); }
});
test("gateway rejects oversized body and positively classifies refused fixed upstream", async () => {
  const dead = await server((_req, res) => res.end()); const port = dead.port; dead.close();
  const handler = createGatewayHandlers({ routes: [{ role: "primary", agentId: "tech", port, token }], controlToken: token }); const proxy = await server(handler.data);
  try { const result = await post(`${proxy.url}/primary/tech/api/edge/agent`, {}); assert.equal(result.status, 503); assert.deepEqual(await result.json(), { code: "edge-unavailable" }); }
  finally { handler.close(); proxy.close(); }
  await gatewayFixture(async data => {
    const response = await post(`${data.url}/primary/tech/api/edge/agent`, { input: "x".repeat(70000) }); assert.equal(response.status, 413);
  });
});

test("inference proxy admits at most one active upstream request", async () => {
  let upstreamCalls = 0;
  const upstream = await server((_req, res) => { upstreamCalls++; res.writeHead(200); res.write('{"done":false}\n'); });
  const handler = createInferenceProxyHandler({ upstreamPort: upstream.port, controlToken: token }); const proxy = await server(handler);
  const controller = new AbortController();
  try {
    const first = await fetch(`${proxy.url}/api/chat`, { method: "POST", headers, body: "{}", signal: controller.signal });
    const rejected = await post(`${proxy.url}/api/chat`, {});
    assert.equal(rejected.status, 503); assert.deepEqual(await rejected.json(), { code: "inference-unavailable" }); assert.equal(upstreamCalls, 1);
    controller.abort(); await assert.rejects(first.text());
  } finally { controller.abort(); handler.close(); proxy.close(); upstream.close(); }
});
test("campaign rejects240 planned samples before configuration or network access", async () => {
  await assert.rejects(campaign({}, 3, 10), /180 sample cap/);
});
test("terminal latency retains undrained failures and recovery denominator includes selected faulted targets without attempts", () => {
  const sample = { scenario: "primary-down", status: "failed", drained: false, elapsedMs: 77, targetAttempted: false, targetSelectionKnown: true, targetRecoveryEligible: true, targetRecovered: false, quality: { wholeRequestRealSuccess: false }, distributed: null };
  const summary = summarize([sample])["primary-down"];
  assert.equal(summary.allTerminalLatencyP50Ms, 77); assert.equal(summary.targetRecoveryEligibleCount, 1); assert.equal(summary.targetRecoveryRate, 0);
});

test("successful backup never erases residual compute risk from a timed out primary or failed synthesis", () => {
  const primary = { agentId: "tech", role: "primary", status: "failed", usageStatus: "unknown", backend: null, reasonCode: "attempt-timeout" };
  const backup = { agentId: "tech", role: "backup", status: "succeeded", usageStatus: "measured", backend: "ollama" };
  assert.equal(residualComputeRisk({ scenario: "healthy-backup-enabled", distributed: { attempts: [primary, backup], stages: [] } }), true);
  assert.equal(residualComputeRisk({ scenario: "healthy-backup-enabled", distributed: { attempts: [backup], stages: [{ backend: "deterministic" }] } }), true);
  assert.equal(residualComputeRisk({ scenario: "primary-down", distributed: { attempts: [{ ...primary, reasonCode: "edge-unavailable" }, backup], stages: [] } }), false);
  assert.equal(residualComputeRisk({ scenario: "healthy-backup-enabled", distributed: null }), true);
});

test("expired campaign fetch cannot abort the independent sample cancellation and drain budget", async () => {
  let cancelled = false; let active;
  const sample = await runSample(config, fixture, "healthy-backup-enabled", {
    onActiveRun: value => { active = value; },
    fetchImpl: async url => {
      if (url.endsWith("/api/runs")) return response({ requestId: "RUN-expired" });
      throw new DOMException("Campaign expired", "AbortError");
    },
    cleanupFetchImpl: async (url, options) => {
      assert.equal(options.signal.aborted, false);
      if (options.method === "DELETE") { assert.equal(active.requestId, "RUN-expired"); cancelled = true; return response({}); }
      if (url.endsWith("/__health")) return response({ activeRequests: 0 });
      if (url.endsWith("/api/health")) return response({ scheduler: { activeCount: 0, queueDepth: 0 } });
      if (url.includes("/api/telemetry")) return response({ runs: [] });
      return response({ status: "cancelled", executionSettled: true });
    },
  });
  assert.equal(cancelled, true); assert.equal(sample.drained, true); assert.equal(active, null); assert.equal(sample.campaignStopRequired, true);
});
test("SIGINT and SIGTERM abort admission while retained active request is cancelled and faults restored independently", async () => {
  for (const signalName of ["SIGINT", "SIGTERM"]) {
    const source = new EventEmitter(); const controller = new AbortController(); let observed;
    const remove = installCampaignInterrupts(controller, name => { observed = name; }, source);
    source.emit(signalName); assert.equal(controller.signal.aborted, true); assert.equal(observed, signalName);
    const actions = [];
    const outcome = await cleanupCampaign({ ...config, gatewayControlUrl: "http://127.0.0.1:19444", gatewayControlToken: token }, { coreUrl: config.coreUrl, token, requestId: "RUN-active" }, {
      fetchImpl: async (url, options) => {
        assert.equal(options.signal.aborted, false);
        if (options.method === "DELETE") { actions.push("cancel"); return response({}); }
        if (url.endsWith("/fault") || url.endsWith("/__control")) { actions.push("restore"); return response({}); }
        if (url.endsWith("/__health")) return response({ activeRequests: 0 });
        if (url.endsWith("/api/health")) return response({ scheduler: { activeCount: 0, queueDepth: 0 } });
        return response({ status: "cancelled", executionSettled: true });
      },
    });
    assert.deepEqual(actions, ["cancel", "restore", "restore"]);
    assert.deepEqual(outcome, { cancellationConfirmed: true, transportDrained: true, faultsRestored: true });
    remove(); assert.equal(source.listenerCount(signalName), 0);
  }
});
test("missing telemetry and null attempt bytes keep complete payload totals null with separate known coverage", () => {
  const base = { scenario: "primary-down", status: "completed", elapsedMs: 1, quality: {}, targetRecoveryEligible: true, targetSelectionKnown: true };
  const sample = (requestBytesPrepared, responseBytesReceived) => ({ ...base, distributed: { attempts: [{ requestBytesPrepared, responseBytesReceived }], totals: { requestBytesPrepared, responseBytesReceived, promptTokens: null, completionTokens: null, unknownCount: 1 } } });
  const summary = summarize([sample(5, 7), sample(null, 4), { ...base, distributed: null }])["primary-down"];
  assert.equal(summary.requestBytesPrepared, null); assert.equal(summary.responseBytesReceived, null);
  assert.equal(summary.knownRequestBytesPrepared, 5); assert.equal(summary.knownResponseBytesReceived, 11);
  assert.equal(summary.requestByteMeasuredSamples, 1); assert.equal(summary.responseByteMeasuredSamples, 2);
  assert.equal(summary.requestByteUnknownSamples, 2); assert.equal(summary.responseByteUnknownSamples, 1);
});
