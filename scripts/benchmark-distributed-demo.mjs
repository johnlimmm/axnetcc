import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const terminal = new Set(["completed", "partial_failed", "failed", "cancelled"]);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const scenarios = ["healthy-backup-disabled", "healthy-backup-enabled", "primary-down", "inference-down", "backup-down", "both-down", "restored-primary", "caller-cancelled"];
function endpoint(base, path) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid benchmark endpoint");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Non-loopback benchmark endpoints require HTTPS");
  return new URL(path, url).toString();
}
async function requestJson(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, { ...options, redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers }, signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
  if (!response.ok) throw new Error(`http-${response.status}`);
  return response.json();
}
export function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] : null;
}
export function assessQuality(snapshot, fixture) {
  const result = snapshot.result ?? {};
  const selected = (Array.isArray(result.agents) ? result.agents : []).filter(agent => agent.selected);
  const text = typeof result.conclusion === "string" ? result.conclusion : typeof result.answer === "string" ? result.answer : "";
  const evidenceIds = new Set(selected.flatMap(agent => Array.isArray(agent.evidence) ? agent.evidence.map(item => item.id) : []));
  const citations = [...text.matchAll(/\[([^\]\n]+)\]/g)].map(match => match[1]);
  const invalidCitations = citations.filter(id => !evidenceIds.has(id));
  const evidencePassed = text.trim().length > 0 && citations.length > 0 && invalidCitations.length === 0;
  return { nonemptyAnswer: text.trim().length > 0, selectedAgentCount: selected.length, citationCount: citations.length, invalidCitationCount: invalidCitations.length,
    evidencePassed, expectedTermMatches: fixture.expectedTerms.filter(term => text.toLowerCase().includes(term.toLowerCase())).length,
    expectedTermCount: fixture.expectedTerms.length, semanticReviewRequired: true,
    wholeRequestRealSuccess: snapshot.status === "completed" && result.metrics?.llmBackend === "ollama" && selected.length > 0 && selected.every(agent => agent.inference?.backend === "ollama") && evidencePassed };
}
export function residualComputeRisk(sample, faultAgentId = "all") {
  if (sample.cancellationRequested || !sample.distributed) return true;
  for (const attempt of sample.distributed.attempts ?? []) {
    if (attempt.usageStatus === "not-started") continue;
    if (attempt.status === "succeeded" && attempt.backend === "ollama") continue;
    if (attempt.status === "failed" && attempt.adopted === false && attempt.backend === "ollama" && attempt.reasonCode === "inference-invalid" && attempt.providerFinalObserved === true) continue;
    const selectedFault = faultAgentId === "all" || faultAgentId === attempt.agentId;
    const deliberateRouteRejection = attempt.reasonCode === "edge-unavailable" && selectedFault &&
      (sample.scenario === "both-down" || sample.scenario === `${attempt.role}-down`);
    const deliberateInferenceRejection = attempt.reasonCode === "inference-unavailable" && sample.scenario === "inference-down" && attempt.role === "primary";
    if (!deliberateRouteRejection && !deliberateInferenceRejection) return true;
  }
  if (sample.distributed.accountingIncomplete === true) return true;
  if (Array.isArray(sample.distributed.calls) && sample.distributed.calls.length) {
    return sample.distributed.calls.some(call => call.status === "cancelled" || (call.backend !== "ollama" &&
      !(call.backend === "deterministic" && call.status === "failed" && call.failureCode === "invalid-response" && call.providerFinalObserved === true)));
  }
  return (sample.distributed.stages ?? []).some(stage => stage.backend !== "ollama");
}
export async function runSample(config, fixture, scenario, { fetchImpl = fetch, cleanupFetchImpl = fetchImpl, onActiveRun = () => {}, wait = sleep, now = Date.now } = {}) {
  let cleanupSignal;
  const cleanupFetch = (url, options) => {
    cleanupSignal ??= AbortSignal.timeout(45000);
    return cleanupFetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, cleanupSignal]) });
  };
  const baseline = scenario === "healthy-backup-disabled";
  if (baseline && !config.baselineUrl) return { scenario, fixtureId: fixture.id, skipped: true, reasonCode: "baseline-not-configured" };
  const coreUrl = baseline ? config.baselineUrl : config.coreUrl;
  const token = baseline ? config.baselineToken ?? config.operatorToken : config.operatorToken;
  const timeoutMs = Math.min(120000, Math.max(100, config.timeoutMs ?? 120000));
  const startedAt = now(); const deadlineAt = startedAt + timeoutMs;
  let requestId = null; let snapshot = null; let cancellationRequested = false; let uncertain = false; let reasonCode = null;
  try {
    const started = await requestJson(fetchImpl, endpoint(coreUrl, "/api/runs"), token, { method: "POST", headers: { "idempotency-key": `demo-${randomUUID()}` }, timeoutMs: Math.max(1, Math.min(10000, deadlineAt - now())), body: JSON.stringify({ query: fixture.query, mode: "proposed", commercialJudge: false }) });
    if (typeof started.requestId !== "string" || !/^RUN-[a-zA-Z0-9-]+$/.test(started.requestId)) throw new Error("invalid-run-id");
    requestId = started.requestId;
    onActiveRun({ coreUrl, token, requestId });
    while (now() < deadlineAt) {
      snapshot = await requestJson(fetchImpl, endpoint(coreUrl, `/api/runs/${requestId}`), token, { timeoutMs: Math.max(1, Math.min(10000, deadlineAt - now())) });
      if (terminal.has(snapshot.status) && snapshot.executionSettled === true) break;
      if (scenario === "caller-cancelled" && !cancellationRequested) {
        await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token, { method: "DELETE" }); cancellationRequested = true;
      }
      await wait(Math.max(0, Math.min(250, deadlineAt - now())));
    }
    if (!snapshot || !terminal.has(snapshot.status) || snapshot.executionSettled !== true) {
      reasonCode = "sample-timeout";
      await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token, { method: "DELETE" }); cancellationRequested = true;
    }
  } catch (error) {
    reasonCode = /^http-[0-9]{3}$|^invalid-run-id$/.test(error.message) ? error.message : "sample-transport-failure";
    if (!requestId) uncertain = true;
    else {
      try { await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token, { method: "DELETE" }); cancellationRequested = true; }
      catch { uncertain = true; }
    }
  }
  let drained = false; let proxyDrained = false;
  if (requestId) {
    const drainDeadline = now() + Math.min(30000, config.drainTimeoutMs ?? 30000);
    try {
      do {
        snapshot = await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token);
        const health = await requestJson(cleanupFetch, endpoint(coreUrl, "/api/health"), token);
        if (config.inferenceControlUrl) {
          const proxyHealth = await requestJson(cleanupFetch, endpoint(config.inferenceControlUrl, "/__health"), config.inferenceControlToken);
          proxyDrained = proxyHealth.activeRequests === 0;
        }
        drained = snapshot.executionSettled === true && terminal.has(snapshot.status) && health.scheduler?.activeCount === 0 && health.scheduler?.queueDepth === 0 && (proxyDrained || (!cancellationRequested && !config.inferenceControlUrl));
        if (drained) break;
        await wait(250);
      } while (now() < drainDeadline);
    } catch { drained = false; }
    uncertain ||= !drained;
  }
  let telemetry = null; let telemetryInstanceId = null;
  if (requestId && drained) {
    try {
      let cursor = 0; let instance;
      for (let page = 0; page < 25; page++) {
        const payload = await requestJson(cleanupFetch, endpoint(coreUrl, `/api/telemetry?after=${cursor}${instance ? `&instance=${encodeURIComponent(instance)}` : ""}`), config.telemetryToken ?? token);
        telemetryInstanceId = payload.instanceId ?? null;
        telemetry = payload.runs?.find(run => run.runId === requestId) ?? telemetry;
        if (telemetry || !payload.hasMore) break; cursor = payload.nextCursor; instance = payload.instanceId;
      }
    } catch { reasonCode ??= "telemetry-unavailable"; }
  }
  if (drained) onActiveRun(null);
  const quality = assessQuality(snapshot ?? {}, fixture);
  const attempts = telemetry?.distributed?.attempts ?? [];
  const target = attempts.filter(attempt => attempt.agentId === (config.targetAgent ?? fixture.targetAgent));
  const targetResult = snapshot?.result?.agents?.find(agent => agent.id === (config.targetAgent ?? fixture.targetAgent) && agent.selected);
  const targetEvidence = new Set((targetResult?.evidence ?? []).map(item => item.id));
  const targetCitations = [...String(targetResult?.summary ?? "").matchAll(/\[([^\]\n]+)\]/g)].map(match => match[1]);
  const targetEvidencePassed = targetCitations.length > 0 && targetCitations.every(id => targetEvidence.has(id));
  const targetId = config.targetAgent ?? fixture.targetAgent;
  const targetSelectionKnown = Array.isArray(snapshot?.result?.agents) || Array.isArray(snapshot?.tasks);
  const targetSelected = Boolean(targetResult) || Boolean(snapshot?.tasks?.some(task => task.kind === "agent" && task.assignee === targetId && task.required));
  const targetFaulted = scenario === "inference-down" || (["primary-down", "both-down"].includes(scenario) && (!config.faultAgentId || config.faultAgentId === "all" || config.faultAgentId === targetId));
  const recovered = targetEvidencePassed && target.some(attempt => attempt.role === "backup" && attempt.adopted && attempt.backend === "ollama");
  const primary = target.find(attempt => attempt.role === "primary");
  const backup = target.find(attempt => attempt.role === "backup");
  const computeRisk = residualComputeRisk({ scenario, cancellationRequested, distributed: telemetry?.distributed ?? null }, config.faultAgentId ?? "all");
  return { scenario, fixtureId: fixture.id, requestId, startedAt, completedAt: now(), elapsedMs: Number.isFinite(snapshot?.completedAt) && Number.isFinite(snapshot?.createdAt) ? Math.max(0, snapshot.completedAt - snapshot.createdAt) : now() - startedAt, collectionElapsedMs: now() - startedAt, telemetryInstanceId,
    status: snapshot?.status ?? "unknown", cancellationRequested, executionSettled: snapshot?.executionSettled === true, drained, proxyDrained, backendComputeStoppedProven: false, campaignStopRequired: computeRisk, residualComputeRisk: computeRisk, uncertain, reasonCode,
    quality, targetAgent: config.targetAgent ?? fixture.targetAgent, targetAttempted: target.length > 0, targetSelected, targetSelectionKnown, targetRecoveryEligible: targetSelected && targetFaulted, targetEvidencePassed, targetRecovered: recovered,
    timeToBackupMs: primary && backup ? Math.max(0, backup.startedAt + backup.queueWaitMs - primary.startedAt) : null,
    distributed: telemetry?.distributed ?? null, result: snapshot?.result ?? null };
}
export function summarize(samples) {
  const output = {};
  for (const scenario of scenarios) {
    const all = samples.filter(sample => sample.scenario === scenario && !sample.skipped);
    if (!all.length) { output[scenario] = { count: 0, skipped: true }; continue; }
    const real = all.filter(sample => sample.quality?.wholeRequestRealSuccess);
    const attempted = all.filter(sample => sample.targetAttempted);
    const eligible = all.filter(sample => sample.targetRecoveryEligible);
    const complete = all.filter(sample => sample.distributed?.totals?.promptTokens !== null && Number.isFinite(sample.distributed?.totals?.promptTokens) && Number.isFinite(sample.distributed?.totals?.completionTokens));
    const hasBytes = value => Number.isSafeInteger(value) && value >= 0;
    const prepared = all.filter(sample => hasBytes(sample.distributed?.totals?.requestBytesPrepared) && Array.isArray(sample.distributed?.attempts) && sample.distributed.attempts.every(attempt => hasBytes(attempt.requestBytesPrepared)));
    const received = all.filter(sample => hasBytes(sample.distributed?.totals?.responseBytesReceived) && Array.isArray(sample.distributed?.attempts) && sample.distributed.attempts.every(attempt => hasBytes(attempt.responseBytesReceived)));
    const knownPrepared = all.reduce((sum, sample) => sum + (sample.distributed?.attempts ?? []).reduce((subtotal, attempt) => subtotal + (hasBytes(attempt.requestBytesPrepared) ? attempt.requestBytesPrepared : 0), 0), 0);
    const knownReceived = all.reduce((sum, sample) => sum + (sample.distributed?.attempts ?? []).reduce((subtotal, attempt) => subtotal + (hasBytes(attempt.responseBytesReceived) ? attempt.responseBytesReceived : 0), 0), 0);
    output[scenario] = { count: all.length, failedOrPartialCount: all.filter(sample => sample.status !== "completed").length,
      unknownCount: all.filter(sample => !sample.distributed || sample.distributed.totals.unknownCount > 0).length,
      realSuccessCount: real.length, realSuccessRate: real.length / all.length,
      targetAttemptedCount: attempted.length, targetRecoveryEligibleCount: eligible.length, targetSelectionUnknownCount: all.filter(sample => !sample.targetSelectionKnown).length, targetRecoveryCount: eligible.filter(sample => sample.targetRecovered).length,
      targetRecoveryRate: eligible.length ? eligible.filter(sample => sample.targetRecovered).length / eligible.length : null,
      allTerminalLatencyP50Ms: percentile(all.filter(sample => terminal.has(sample.status)).map(sample => sample.elapsedMs), .5),
      allTerminalLatencyP95Ms: percentile(all.filter(sample => terminal.has(sample.status)).map(sample => sample.elapsedMs), .95),
      realSuccessLatencyP50Ms: percentile(real.map(sample => sample.elapsedMs), .5), realSuccessLatencyP95Ms: percentile(real.map(sample => sample.elapsedMs), .95),
      timeToBackupP50Ms: percentile(all.map(sample => sample.timeToBackupMs), .5),
      completeCostSamples: complete.length,
      completePromptTokens: complete.length === all.length ? complete.reduce((sum, sample) => sum + sample.distributed.totals.promptTokens, 0) : null,
      completeCompletionTokens: complete.length === all.length ? complete.reduce((sum, sample) => sum + sample.distributed.totals.completionTokens, 0) : null,
      knownPromptTokens: all.reduce((sum, sample) => sum + (sample.distributed?.totals.knownPromptTokens ?? 0), 0),
      knownCompletionTokens: all.reduce((sum, sample) => sum + (sample.distributed?.totals.knownCompletionTokens ?? 0), 0),
      requestBytesPrepared: prepared.length === all.length ? knownPrepared : null,
      responseBytesReceived: received.length === all.length ? knownReceived : null,
      knownRequestBytesPrepared: knownPrepared, knownResponseBytesReceived: knownReceived,
      requestByteMeasuredSamples: prepared.length, responseByteMeasuredSamples: received.length,
      requestByteUnknownSamples: all.length - prepared.length, responseByteUnknownSamples: all.length - received.length };
  }
  return output;
}
async function setScenario(config, scenario, fetchImpl = fetch) {
  const routeScenario = ["primary-down", "backup-down", "both-down"].includes(scenario) ? scenario : "healthy";
  await requestJson(fetchImpl, endpoint(config.gatewayControlUrl, "/fault"), config.gatewayControlToken, { method: "POST", body: JSON.stringify({ scenario: routeScenario, agentId: config.faultAgentId ?? "all", ttlMs: 180000 }) });
  if (config.inferenceControlUrl) await requestJson(fetchImpl, endpoint(config.inferenceControlUrl, "/__control"), config.inferenceControlToken, { method: "POST", body: JSON.stringify({ unavailable: scenario === "inference-down", ttlMs: 180000 }) });
  else if (scenario === "inference-down") throw new Error("Inference controller not configured");
}
/** Interruption stops admission; cleanup keeps an independent, finite budget. */
export function installCampaignInterrupts(controller, observe, source = process) {
  const handlers = new Map(["SIGINT", "SIGTERM"].map(name => [name, () => { observe(name); controller.abort(new Error("Campaign interrupted")); }]));
  for (const [name, handler] of handlers) source.on(name, handler);
  return () => { for (const [name, handler] of handlers) source.removeListener(name, handler); };
}
export async function cleanupCampaign(config, activeRun, { fetchImpl = fetch, wait = sleep, now = Date.now } = {}) {
  const signal = AbortSignal.timeout(45000);
  const cleanupFetch = (url, options) => fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, signal]) });
  const outcome = { cancellationConfirmed: activeRun === null, transportDrained: activeRun === null, faultsRestored: false };
  try {
    if (activeRun) {
      const { coreUrl, token, requestId } = activeRun;
      await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token, { method: "DELETE" });
      outcome.cancellationConfirmed = true;
      const drainDeadline = now() + 30000;
      do {
        const snapshot = await requestJson(cleanupFetch, endpoint(coreUrl, `/api/runs/${requestId}`), token);
        const health = await requestJson(cleanupFetch, endpoint(coreUrl, "/api/health"), token);
        const proxy = config.inferenceControlUrl ? await requestJson(cleanupFetch, endpoint(config.inferenceControlUrl, "/__health"), config.inferenceControlToken) : null;
        outcome.transportDrained = snapshot.executionSettled === true && terminal.has(snapshot.status) && health.scheduler?.activeCount === 0 && health.scheduler?.queueDepth === 0 && proxy?.activeRequests === 0;
        if (outcome.transportDrained) break;
        await wait(250);
      } while (now() < drainDeadline && !signal.aborted);
    }
  } catch { /* The explicit outcome retains failed cancellation/drain evidence. */ }
  finally {
    try { await setScenario(config, "healthy-backup-enabled", cleanupFetch); outcome.faultsRestored = true; }
    catch { /* TTL remains the final bound if the controller is unreachable. */ }
  }
  return outcome;
}
export async function campaign(config, count = 1, repeats = 1) {
  const campaignStartedAt = Date.now();
  const campaignDeadlineAt = campaignStartedAt + 2 * 60 * 60 * 1000;
  const campaignController = new AbortController();
  const boundedFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, campaignController.signal]) });
  if (!Number.isInteger(count) || count < 1 || count > 3 || !Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("Count must be1..3 and repeats1..10; concurrency is fixed1");
  if (count * repeats * scenarios.length > 180) throw new Error("Campaign exceeds180 sample cap");
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(config.deploymentId ?? "")) throw new Error("Deployment ID required");
  const fixtureData = JSON.parse(readFileSync(config.fixturesFile ?? "data/evaluation/distributed-demo-fixtures.json", "utf8"));
  if (fixtureData.classification !== "public-synthetic" || fixtureData.fixtures.length < count) throw new Error("Public fixture manifest required");
  const manifest = { schemaVersion: "distributed-demo/v1", source: "live-distributed-campaign", configuredProfile: config.profile === "service" ? "service" : "operator-or-unspecified", deploymentId: config.deploymentId, startedAt: new Date().toISOString(), seed: fixtureData.seed, count, repeats, concurrency: 1,
    synthesisModelVersion: config.synthesisModelVersion ?? null, synthesisMaxTokens: config.synthesisMaxTokens ?? 384,
    modelVersion: config.modelVersion, corpusVersion: config.corpusVersion, workloadHash: hash(fixtureData), configurationHash: hash({ deploymentId: config.deploymentId, synthesisModelVersion: config.synthesisModelVersion ?? null, synthesisMaxTokens: config.synthesisMaxTokens ?? 384, modelVersion: config.modelVersion, corpusVersion: config.corpusVersion, timeoutMs: config.timeoutMs ?? 120000, targetAgent: config.targetAgent ?? "fixture-specific", faultAgentId: config.faultAgentId ?? "all", baselineConfigured: Boolean(config.baselineUrl), scenarios, count, repeats }),
    topology: "primary-ai-cloud_backup-mnckoren_core-hpc", physicalHostIndependenceVerified: false,
    campaignDeadlineAt, maximumSamples: 180,
    byteSemantics: "Prepared request JSON and received response body; excludes HTTP/TLS/NIC overhead", semanticReviewRequired: true };
  const directory = resolve(config.outputRoot ?? "outputs/distributed-demo", `${config.deploymentId}-${Date.now()}`); mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
  const campaignTimer = setTimeout(() => campaignController.abort(), Math.max(0, campaignDeadlineAt - Date.now())); campaignTimer.unref();
  const samples = []; let interrupted = false; let stopReason = null; let activeRun = null; let shutdown = null;
  const removeInterruptHandlers = installCampaignInterrupts(campaignController, name => { interrupted = true; stopReason = `interrupted-${name.toLowerCase()}`; });
  try {
    for (const scenario of scenarios) {
      const scenarioRepeats = scenario === "caller-cancelled" ? 1 : repeats;
      const scenarioFixtures = fixtureData.fixtures.slice(0, scenario === "caller-cancelled" ? 1 : count);
      for (let repeat = 0; repeat < scenarioRepeats; repeat++) for (const fixture of scenarioFixtures) {
        if (Date.now() >= campaignDeadlineAt) { stopReason = "campaign-deadline"; throw new Error("Campaign deadline"); }
        await setScenario(config, scenario, boundedFetch);
        const sample = { ...await runSample(config, fixture, scenario, { fetchImpl: boundedFetch, cleanupFetchImpl: fetch, onActiveRun: value => { activeRun = value; } }), repeat };
        samples.push(sample); appendFileSync(resolve(directory, "samples.jsonl"), JSON.stringify(sample) + "\n");
        if (sample.uncertain) { stopReason ??= "uncertain-execution-drain"; throw new Error("Execution did not drain; campaign stopped"); }
        if (sample.campaignStopRequired) { stopReason ??= scenario === "caller-cancelled" ? "planned-final-cancellation" : "residual-compute-unproven-demo-restart-required"; throw new Error("Conservative cancellation stop"); }
      }
    }
  } catch { interrupted = true; stopReason ??= campaignController.signal.aborted ? "campaign-deadline" : "campaign-control-or-transport-failure"; }
  finally {
    shutdown = await cleanupCampaign(config, activeRun);
    if (!shutdown.faultsRestored || !shutdown.cancellationConfirmed || !shutdown.transportDrained) { interrupted = true; stopReason ??= "shutdown-unconfirmed-ttl-active"; }
    clearTimeout(campaignTimer);
    removeInterruptHandlers();
  }
  const report = { ...manifest, completedAt: new Date().toISOString(), status: interrupted || samples.some(sample => sample.skipped || sample.uncertain || !sample.distributed) ? "partial" : "measured-awaiting-semantic-review", stopReason, shutdown, summary: summarize(samples), sampleCount: samples.length };
  writeFileSync(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  const csv = ["scenario,fixture,request_id,status,elapsed_ms,real_success,target_recovered,unknown_inference,prompt_tokens,completion_tokens,known_prompt_tokens,known_completion_tokens,prepared_bytes,received_bytes"];
  for (const sample of samples) csv.push([sample.scenario, sample.fixtureId, sample.requestId, sample.status, sample.elapsedMs, sample.quality?.wholeRequestRealSuccess, sample.targetRecovered, sample.distributed?.totals.unknownCount, sample.distributed?.totals.promptTokens, sample.distributed?.totals.completionTokens, sample.distributed?.totals.knownPromptTokens, sample.distributed?.totals.knownCompletionTokens, sample.distributed?.totals.requestBytesPrepared, sample.distributed?.totals.responseBytesReceived].map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","));
  writeFileSync(resolve(directory, "samples.csv"), csv.join("\n") + "\n"); return { directory, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes("--config")) throw new Error("Usage: node scripts/benchmark-distributed-demo.mjs --config PRIVATE_JSON [--count1..3] [--repeats1..10]");
  const { directory, report } = await campaign(JSON.parse(readFileSync(value("--config"), "utf8")), args.includes("--count") ? Number(value("--count")) : 1, args.includes("--repeats") ? Number(value("--repeats")) : 1);
  console.log(JSON.stringify({ directory, status: report.status, sampleCount: report.sampleCount }));
}
