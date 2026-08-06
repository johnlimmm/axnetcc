import { execFileSync, fork } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import { allowed, byteLength, conceptMatches, coverage, modes, seeded, transform } from "../emulation/runtime.mjs";
import { agentProfiles, knowledge } from "../lib/knowledge.ts";

const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const quick = args.has("--quick") || !full;
const maxQueriesArg = process.argv.find((item) => item.startsWith("--max-queries="));
const queryLimit = maxQueriesArg ? Number(maxQueriesArg.split("=")[1]) : (full ? Infinity : 8);
const datasetArg = process.argv.find((item) => item.startsWith("--dataset="));
const datasetPath = datasetArg?.split("=")[1] ?? "data/evaluation/golden-set.jsonl";
const repetitionsArg = process.argv.find((item) => item.startsWith("--repetitions="));
const repetitions = repetitionsArg ? Number(repetitionsArg.split("=")[1]) : full ? 30 : (args.has("--smoke") ? 1 : 3);
const profileSeedsArg = process.argv.find((item) => item.startsWith("--profile-seeds="));
const profileSeeds = profileSeedsArg ? profileSeedsArg.split("=")[1].split(",").map(Number) : full ? [17, 29, 43] : [17];
const concurrencyArg = process.argv.find((item) => item.startsWith("--concurrency="));
const concurrency = Math.max(1, Number(concurrencyArg?.split("=")[1] ?? (full ? 24 : 1)));
const ablationRepetitionsArg = process.argv.find((item) => item.startsWith("--ablation-repetitions="));
const ablationRepetitions = Math.max(1, Number(ablationRepetitionsArg?.split("=")[1] ?? (full ? 30 : 1)));
const routingComparison = args.has("--routing-comparison");
const methods = routingComparison
  ? ["centralized-legacy", "parallel-legacy", "masrouter-legacy", "remoterag-legacy", "pgrf-legacy", "pgrf-saea", "axnetcc-saea"]
  : ["raw-central", "always-local", "fixed-sanitized", "network-only", "security-only", "axnetcc-saea", "oracle-feasible"];
const ablations = ["axnetcc-saea-full", "without-policy-constraint", "without-coverage-constraint", "without-sensitivity-criterion", "without-network-criterion", "weighted-objective"];
const activeAblations = routingComparison || args.has("--no-ablation") ? [] : ablations;
const scenariosText = await readFile(new URL("../emulation/scenarios.json", import.meta.url), "utf8");
const corpusText = await readFile(new URL("../data/rag-corpus.json", import.meta.url), "utf8");
const securityManifestText = await readFile(new URL("../data/security-evidence-manifest.json", import.meta.url), "utf8");
const scenarios = JSON.parse(scenariosText);
const corpus = JSON.parse(corpusText);
const securityManifest = JSON.parse(securityManifestText);
const derivedRoleManifest = await readOptionalJson(new URL("../data/evaluation/ax-golden-set-40-security-manifest.json", import.meta.url));
const datasetText = await readFile(new URL(`../${datasetPath}`, import.meta.url), "utf8");
const golden = datasetText.trim().split(/\r?\n/).map(JSON.parse).slice(0, queryLimit);
const runIdArg = process.argv.find((item) => item.startsWith("--run-id="));
const runId = runIdArg?.split("=")[1] ?? `security-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outputDir = new URL(`../data/evaluation/security-evidence/${runId}/`, import.meta.url);
await mkdir(outputDir, { recursive: true });
const checkpointTraceUrl = new URL("raw-traces.checkpoint.jsonl", outputDir);
const completedJobsUrl = new URL("completed-jobs.jsonl", outputDir);
const traces = await readJsonLines(checkpointTraceUrl);
const completedJobs = new Set((await readText(completedJobsUrl)).split(/\r?\n/).filter(Boolean));
const inputHashes = { datasetSha256: sha256(datasetText), corpusSha256: sha256(corpusText), scenariosSha256: sha256(scenariosText), securityManifestSha256: sha256(securityManifestText) };
await writeFile(new URL("run-plan.json", outputDir), JSON.stringify({ runId, full, routingComparison, datasetPath, ...inputHashes, queries: golden.length, methods, scenarios: Object.keys(scenarios), repetitions, profileSeeds, ablationRepetitions, concurrency }, null, 2));
let checkpointQueue = Promise.resolve();
const checkpointBuffer = [];

const supervisor = fork(new URL("../emulation/emulation-supervisor.mjs", import.meta.url), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("emulation startup timeout")), 10000); supervisor.on("message", (message) => { if (message?.type === "ready") { clearTimeout(timer); resolve(); } }); supervisor.on("exit", (code) => reject(new Error(`emulation exited ${code}`))); });

try {
  const primaryJobs = []; const oracleJobs = [];
  for (const profileSeed of profileSeeds) for (let repetition = 0; repetition < repetitions; repetition += 1) for (const query of golden) for (const [scenarioName] of Object.entries(scenarios)) for (const method of methods) {
    const key = ["primary", query.id, method, scenarioName, profileSeed, repetition].join(":");
    if (!completedJobs.has(key)) (method === "oracle-feasible" ? oracleJobs : primaryJobs).push({ key, run: () => execute(query, method, scenarioName, profileSeed, repetition) });
  }
  traces.push(...(await runPool(shuffleJobs(primaryJobs, 20260806), concurrency, checkpoint)).flat()); await flushCheckpoint();
  traces.push(...(await runPool(shuffleJobs(oracleJobs, 20260807), concurrency, checkpoint)).flat()); await flushCheckpoint();
  if (!routingComparison && !args.has("--no-ablation")) {
    const ablationJobs = [];
    for (const profileSeed of profileSeeds) for (let repetition = 0; repetition < ablationRepetitions; repetition += 1) for (const query of golden) for (const [scenarioName] of Object.entries(scenarios)) for (const ablation of ablations) {
      const key = ["ablation", query.id, ablation, scenarioName, profileSeed, repetition].join(":");
      if (!completedJobs.has(key)) ablationJobs.push({ key, run: () => execute(query, ablation, scenarioName, profileSeed, repetition) });
    }
    traces.push(...(await runPool(shuffleJobs(ablationJobs, 20260808), concurrency, checkpoint)).flat()); await flushCheckpoint();
  }
} finally { supervisor.kill("SIGTERM"); }

// A forced process termination can occur between the trace append and the
// completed-job append.  On resume that job is deliberately re-executed.  Keep
// the last (completed) occurrence in the finalized, analysis-facing dataset,
// while retaining the append-only checkpoint as the audit source.
const normalizedTraces = traces.map((trace) => ({ ...trace, policyBypassForExperiment: trace.policyBypassForExperiment ?? Boolean(trace.policyViolation && ["raw-central", "network-only", "without-policy-constraint"].includes(trace.method)) }));
const finalizedById = new Map();
for (const trace of normalizedTraces) finalizedById.set(trace.traceId, trace);
const finalizedTraces = [...finalizedById.values()];
const removedResumeDuplicates = normalizedTraces.length - finalizedTraces.length;
await writeFile(new URL("RESUME_DEDUPLICATION_AUDIT.json", outputDir), JSON.stringify({
  policy: "last-observation-per-deterministic-traceId",
  rationale: "A trace may be appended immediately before a forced termination prevents its completed-job key from being appended. The resumed, completed execution is the last observation.",
  checkpointTraceCount: normalizedTraces.length,
  finalizedTraceCount: finalizedTraces.length,
  removedResumeDuplicates,
  checkpointPreserved: true,
  generatedAt: new Date().toISOString(),
}, null, 2));
const transportRecoveryUrl = new URL("TRANSPORT_RECOVERY_AUDIT.json", outputDir);
const transportRecovery = await readOptionalJson(transportRecoveryUrl);
if (transportRecovery.removedCompletedJobKeys) await writeFile(transportRecoveryUrl, JSON.stringify({
  ...transportRecovery,
  status: finalizedTraces.some((trace) => trace.httpStatus === 599) ? "rerun-complete-with-remaining-failures" : "rerun-complete",
  remainingFinalTransportFailures: finalizedTraces.filter((trace) => trace.httpStatus === 599).length,
  completedAt: new Date().toISOString(),
}, null, 2));
const config = { runId, mode: routingComparison ? (full ? "routing-full" : "routing-quick") : full ? "full" : datasetArg ? "validation" : quick ? "quick" : "custom", datasetPath, ...inputHashes, queries: golden.length, methods, scenarios: Object.keys(scenarios), repetitions, profileSeeds, ablations: activeAblations, ablationRepetitions: activeAblations.length ? ablationRepetitions : 0, concurrency, totalTraces: finalizedTraces.length, bootstrapSeed: 20260806, bootstrapResamples: 10000, actualHttp: true, syntheticProfile: true };
await writeFile(new URL("experiment-config.json", outputDir), JSON.stringify(config, null, 2));
await writeFile(new URL("environment.json", outputDir), JSON.stringify({ node: process.version, nodeVersions: process.versions, platform: process.platform, arch: process.arch, osRelease: os.release(), cpuModel: os.cpus()[0]?.model ?? "unknown", logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), executionConcurrency: concurrency, gitHead: git(["rev-parse", "HEAD"]), gitBranch: git(["branch", "--show-current"]), gitDirty: Boolean(git(["status", "--porcelain"])), inputHashes, generatedAt: new Date().toISOString(), emulation: "application-layer-http", physicalKorenMeasurement: false, packetLevelWireBytes: false }, null, 2));
await writeFile(new URL("raw-traces.jsonl", outputDir), finalizedTraces.map((trace) => JSON.stringify(trace)).join("\n") + "\n");
await writeFile(new URL("request-level-results.csv", outputDir), csv(finalizedTraces));
await writeFile(new URL("RUN_COMPLETE", outputDir), "analysis pending\n");
console.log(new URL(".", outputDir).pathname);

async function checkpoint(key, result) {
  checkpointBuffer.push({ key, result });
  if (checkpointBuffer.length < 128) return;
  await flushCheckpoint();
}
async function flushCheckpoint() {
  if (!checkpointBuffer.length) return;
  const batch = checkpointBuffer.splice(0);
  checkpointQueue = checkpointQueue.then(async () => {
    await appendFile(checkpointTraceUrl, batch.flatMap(({ result }) => result).map((trace) => JSON.stringify(trace)).join("\n") + "\n");
    await appendFile(completedJobsUrl, batch.map(({ key }) => key).join("\n") + "\n");
  });
  await checkpointQueue;
}
async function runPool(jobs, limit, onResult) {
  const results = Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await jobs[index].run();
      await onResult(jobs[index].key, results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}
async function readText(url) { try { return await readFile(url, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; } }
async function readJsonLines(url) { const text = await readText(url); return text.trim() ? text.trim().split(/\r?\n/).map(JSON.parse) : []; }
async function readOptionalJson(url) { const text = await readText(url); return text ? JSON.parse(text) : {}; }
function shuffleJobs(jobs, seed) {
  const random = seeded(seed); const shuffled = [...jobs];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

async function execute(query, method, scenarioName, profileSeed, repetition) {
  const adapter = routingAdapter(query.query, method);
  const selected = adapter.roles;
  const completed = await Promise.all(selected.map((role) => executeRole(query, method, adapter.acquisitionMethod, adapter.retrievalQuery, scenarioName, profileSeed, repetition, role)));
  const missing = query.expected_agents.filter((role) => !selected.includes(role)).map((role) => routingMissTrace(query, method, scenarioName, profileSeed, repetition, role));
  return [...completed, ...missing];
}
async function executeRole(query, method, acquisitionMethod, retrievalQuery, scenarioName, profileSeed, repetition, role) {
  const conceptAliases = securityManifest.conceptAliases;
  const localCandidates = knowledge.filter((document) => document.agent === role).map((document) => ({ ...document, ownerDepartment: role, securityLevel: document.classification, canonicalId: `local:${document.id}`, effectiveDate: document.effectiveDate }));
  const publicCandidates = corpus.documents.filter((document) => document.agent === role).map((document) => ({ ...document, ownerDepartment: role, securityLevel: "public", canonicalId: document.sourceSha256, effectiveDate: document.publishedAt ?? "unknown" }));
  const candidates = [...localCandidates, ...publicCandidates];
  const mappedConcepts = securityManifest.queryRoleRequiredConcepts?.[query.id]?.[role] ?? derivedRoleManifest.queryRoleRequiredConcepts?.[query.id]?.[role];
  const requiredConcepts = mappedConcepts ?? (query.expected_agents.includes(role)
    ? query.required_concepts
    : query.required_concepts.filter((concept) => candidates.some((candidate) => candidateCovers(candidate, concept, conceptAliases))));
  const selectedCandidates = selectEvidenceBundle(candidates, requiredConcepts, retrievalQuery, conceptAliases);
  const bundle = buildBundle(selectedCandidates, role, requiredConcepts, conceptAliases);
  const profileLevel = securityManifest.syntheticSecurityProfiles?.[profileSeed]?.[query.id]?.[role] ?? deriveLevel(query, role, profileSeed);
  const effectiveSecurityLevel = maxSecurityLevel([...selectedCandidates.map((candidate) => candidate.securityLevel), profileLevel]);
  bundle.securityLevel = effectiveSecurityLevel;
  const threshold = securityManifest.roleCoverageThresholds[role] ?? 0.7;
  const seed = hashSeed(`${profileSeed}:${repetition}:${query.id}:${method}:${scenarioName}`);
  const weight = { public: 1, internal: 2, confidential: 5, personal: 8 }[effectiveSecurityLevel];
  const baseRequest = { ownerDepartment: role, documentId: bundle.id, derivedDocument: bundle, securityLevel: effectiveSecurityLevel, requesterRole: "core", requesterZone: "core", requiredConcepts, conceptAliases, networkScenario: scenarioName, seed };
  let selectedMode; let plannerInfeasible; let request; let response; let payload; let retries; let attemptSeeds; let elapsedMs;
  if (acquisitionMethod === "oracle-feasible") {
    const trials = [];
    for (const mode of modes) {
      const trialRequest = { ...baseRequest, mode, policyBypassForExperiment: false };
      const result = await fetchEvidence(trialRequest);
      const feasible = result.response.ok && !result.payload.policyViolation && Number(result.payload.coverage ?? 0) >= threshold;
      const objective = [Number(result.payload.responseBytes ?? 0) * weight, result.elapsedMs, Number(result.payload.responseBytes ?? 0), Number(result.payload.transformationMs ?? 0)];
      trials.push({ mode, request: trialRequest, ...result, feasible, objective });
    }
    const chosen = trials.filter((trial) => trial.feasible).sort((left, right) => compareTuple(left.objective, right.objective))[0]
      ?? trials.find((trial) => trial.mode === "metadata-only");
    ({ mode: selectedMode, request, response, payload, retries, elapsedMs, attemptSeeds } = chosen);
    plannerInfeasible = !chosen.feasible;
  } else {
    const planned = chooseMode(acquisitionMethod, bundle, requiredConcepts, conceptAliases, scenarios[scenarioName], threshold);
    plannerInfeasible = planned.infeasible;
    selectedMode = planned.mode;
    request = { ...baseRequest, mode: selectedMode, policyBypassForExperiment: acquisitionMethod === "raw-central" || acquisitionMethod === "network-only" || acquisitionMethod === "without-policy-constraint" };
    ({ response, payload, retries, elapsedMs, attemptSeeds } = await fetchEvidence(request));
  }
  const policyViolation = Boolean(payload.policyViolation || (response.status === 403));
  const crossBoundaryBytes = response.ok ? Number(payload.responseBytes ?? 0) : 0;
  return { queryId: query.id, query: query.query, expectedAgents: query.expected_agents.join("|"), requiredConcepts: requiredConcepts.join("|"), requiredConceptMapping: mappedConcepts ? "derived-manifest" : "query-level", expectedRole: query.expected_agents.includes(role), routingMiss: false, sourceEvidenceIds: bundle.sourceEvidenceIds.join("|"), method, scenario: scenarioName, profileSeed, repetition, ownerDepartment: role, selectedMode, securityLevel: effectiveSecurityLevel, syntheticProfile: true, requestBytes: Number(payload.requestBytes ?? byteLength(request)), responseBytes: Number(payload.responseBytes ?? 0), crossBoundaryBytes, rawCrossBoundaryBytes: selectedMode === "raw" ? crossBoundaryBytes : 0, sensitivityWeightedCrossBoundaryBytes: crossBoundaryBytes * weight, rawReceivingZoneCount: selectedMode === "raw" && crossBoundaryBytes > 0 ? 1 : 0, removedSensitiveFieldCount: Number(payload.removedSensitiveFieldCount ?? 0), policyViolation, policyBypassForExperiment: Boolean(payload.policyBypassForExperiment), coverage: Number(payload.coverage ?? 0), labelBasedCoverage: Number(payload.labelBasedCoverage ?? 0), runtimeProxyCoverage: Number(payload.runtimeProxyCoverage ?? 0), coverageBasis: payload.coverageBasis ?? "runtime-content", roleEvidenceComplete: query.expected_agents.includes(role) && !plannerInfeasible && response.ok && Number(payload.coverage ?? 0) >= threshold, infeasibleRole: plannerInfeasible || response.status === 403, humanReviewRequired: plannerInfeasible, infeasibleReason: plannerInfeasible ? "No transformed evidence meets the role coverage threshold; metadata was transferred only for escalation." : "", elapsedMs: Number(elapsedMs.toFixed(3)), networkDelayMs: Number(payload.emulatedNetworkDelayMs ?? 0), localProcessingMs: Number(payload.transformationMs ?? 0), httpStatus: response.status, httpFailure: !response.ok, retries, retrySeeds: attemptSeeds.join("|"), deadlineSatisfied: elapsedMs <= scenarios[scenarioName].timeoutMs, fallbackCount: retries + Number(plannerInfeasible), policyRejectionCount: response.status === 403 ? 1 : 0, coverageRejectionCount: plannerInfeasible || Number(payload.coverage ?? 0) < threshold ? 1 : 0, traceId: createHash("sha256").update(`${runId}:${query.id}:${method}:${scenarioName}:${profileSeed}:${repetition}:${role}`).digest("hex").slice(0, 16) };
}
async function fetchEvidence(request) {
  const started = performance.now(); let retries = 0; let response; let payload; let lastError; const attemptSeeds = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptSeed = attempt === 0 ? request.seed : hashSeed(`${request.seed}:retry:${attempt}`);
    attemptSeeds.push(attemptSeed);
    try {
      response = await fetch("http://127.0.0.1:4400/proxy/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, seed: attemptSeed, retryAttempt: attempt }) });
      payload = await response.json();
      if (response.status !== 503) break;
    } catch (error) {
      lastError = error;
    }
    retries += 1;
  }
  if (!response || !payload) {
    response = { ok: false, status: 599 };
    payload = { error: "network-fetch-failed", detail: String(lastError?.cause?.code ?? lastError?.message ?? "unknown"), responseBytes: 0, coverage: 0, labelBasedCoverage: 0, runtimeProxyCoverage: 0, transformationMs: 0, emulatedNetworkDelayMs: 0 };
  }
  return { response, payload, retries, attemptSeeds, elapsedMs: performance.now() - started };
}
function routingAdapter(query, method) {
  if (method === "centralized-legacy") return { roles: selectRolesForMode(query, "centralized"), acquisitionMethod: "raw-central", retrievalQuery: query };
  if (method === "parallel-legacy") return { roles: selectRolesForMode(query, "parallel"), acquisitionMethod: "always-local", retrievalQuery: query };
  if (method === "masrouter-legacy") return { roles: selectRolesForMode(query, "masrouter"), acquisitionMethod: "raw-central", retrievalQuery: query };
  if (method === "remoterag-legacy") return { roles: selectRolesForMode(query, "remoterag"), acquisitionMethod: "raw-central", retrievalQuery: generalizeRemoteRagQuery(query).query };
  if (method === "pgrf-legacy") return { roles: selectRolesForMode(query, "proposed"), acquisitionMethod: "always-local", retrievalQuery: query };
  if (method === "pgrf-saea") return { roles: selectRolesForMode(query, "proposed"), acquisitionMethod: "axnetcc-saea", retrievalQuery: query };
  return { roles: queryExpectedRoles(query), acquisitionMethod: method, retrievalQuery: query };
}
function selectRolesForMode(query, mode) {
  const ids = Object.keys(agentProfiles);
  if (mode === "centralized" || mode === "parallel") return ids;
  const scores = Object.fromEntries(ids.map((role) => [role, agentProfiles[role].keywords.reduce((total, keyword) => total + Number(query.toLowerCase().includes(keyword.toLowerCase())), 0)]));
  const relevant = ids.filter((role) => scores[role] > 0).sort((left, right) => scores[right] - scores[left]);
  if (mode === "masrouter" || mode === "remoterag") {
    if (!relevant.length) return [ids.sort((left, right) => scores[right] - scores[left])[0]];
    const collaborationSize = relevant.length === 1 ? 1 : Math.min(4, Math.max(2, Math.ceil(relevant.length * 0.6)));
    return relevant.slice(0, collaborationSize);
  }
  return relevant.length ? relevant : ["tech"];
}
function generalizeRemoteRagQuery(query) {
  const protectedTerms = new Set(["ai", "rag", "llm", "보안", "개인정보", "법적", "법무", "예산", "조달", "운영", "sla", "클라우드", "민원", "데이터"]);
  let replaced = 0;
  const tokens = query.split(/(\s+)/);
  const generalized = tokens.map((token, index) => {
    const normalized = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (normalized.length >= 3 && !protectedTerms.has(normalized) && index % 7 === 0) {
      replaced += 1;
      return "[일반화]";
    }
    return token;
  }).join("");
  return { query: generalized, replaced };
}
function queryExpectedRoles(queryText) { return golden.find((item) => item.query === queryText)?.expected_agents ?? ["tech"]; }
function routingMissTrace(query, method, scenario, profileSeed, repetition, role) {
  return { queryId: query.id, query: query.query, expectedAgents: query.expected_agents.join("|"), expectedRole: true, routingMiss: true, sourceEvidenceIds: "", method, scenario, profileSeed, repetition, ownerDepartment: role, selectedMode: "not-selected", securityLevel: "unknown", syntheticProfile: true, requestBytes: 0, responseBytes: 0, crossBoundaryBytes: 0, rawCrossBoundaryBytes: 0, sensitivityWeightedCrossBoundaryBytes: 0, rawReceivingZoneCount: 0, removedSensitiveFieldCount: 0, policyViolation: false, coverage: 0, labelBasedCoverage: 0, runtimeProxyCoverage: 0, coverageBasis: "routing-miss", roleEvidenceComplete: false, infeasibleRole: true, humanReviewRequired: true, infeasibleReason: "Required role was not selected by the routing baseline.", elapsedMs: 0, networkDelayMs: 0, localProcessingMs: 0, httpStatus: 0, httpFailure: false, retries: 0, deadlineSatisfied: false, fallbackCount: 0, policyRejectionCount: 0, coverageRejectionCount: 1, traceId: createHash("sha256").update(`${runId}:${query.id}:${method}:${scenario}:${profileSeed}:${repetition}:${role}:miss`).digest("hex").slice(0, 16) };
}
function selectMode(strategy, level) {
  if (strategy === "raw-central") return "raw";
  if (strategy === "always-local") return "local-summary";
  if (strategy === "fixed-sanitized") return ["confidential", "personal"].includes(level) ? "local-summary" : "sanitized";
  if (strategy === "network-only") return "metadata-only";
  if (strategy === "security-only") return level === "public" ? "raw" : "local-summary";
  return undefined;
}
function deriveLevel(query, role, seed) {
  if (query.forbidden_output?.length) return "personal";
  const variants = query.data_class === "confidential" || /내부|민감|기밀/.test(query.query)
    ? ["internal", "confidential", "confidential"]
    : query.difficulty === "advanced" || role === "security" || role === "legal"
      ? ["public", "internal", "internal"]
      : ["public", "public", "internal"];
  return variants[[17, 29, 43].indexOf(seed) >= 0 ? [17, 29, 43].indexOf(seed) : Math.abs(seed) % variants.length];
}
function score(document, concepts, aliases = securityManifest.conceptAliases) { const text = `${document.title} ${document.section} ${document.text}`; return concepts.filter((concept) => conceptMatches(text, concept, aliases)).length; }
function retrievalScore(document, query, concepts) {
  const text = `${document.title} ${document.section} ${document.text} ${(document.tags ?? []).join(" ")}`.normalize("NFKC").toLowerCase();
  const terms = `${query} ${concepts.join(" ")}`.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const lexical = terms.filter((term) => text.includes(term)).length;
  return score(document, concepts) * 100 + lexical;
}
function candidateCovers(candidate, concept, aliases) { return conceptMatches(`${candidate.title} ${candidate.section} ${candidate.text} ${(candidate.tags ?? []).join(" ")}`, concept, aliases); }
function selectEvidenceBundle(candidates, concepts, query, aliases) {
  const selected = []; const uncovered = new Set(concepts);
  while (uncovered.size && selected.length < 4) {
    const ranked = candidates.filter((candidate) => !selected.includes(candidate)).map((candidate) => ({ candidate, gain: [...uncovered].filter((concept) => candidateCovers(candidate, concept, aliases)).length, retrieval: retrievalScore(candidate, query, concepts) })).sort((left, right) => right.gain - left.gain || right.retrieval - left.retrieval);
    if (!ranked[0] || (!ranked[0].gain && selected.length)) break;
    selected.push(ranked[0].candidate);
    for (const concept of [...uncovered]) if (candidateCovers(ranked[0].candidate, concept, aliases)) uncovered.delete(concept);
  }
  return selected.length ? selected : [candidates[0]];
}
function buildBundle(candidates, role, concepts, aliases) {
  const ids = candidates.map((candidate) => candidate.id);
  return { id: `bundle:${ids.join("+")}`, canonicalId: createHash("sha256").update(ids.join("|")).digest("hex"), title: candidates.map((candidate) => candidate.title).join(" | "), section: candidates.map((candidate) => `${candidate.id}:${candidate.section}`).join(" | "), ownerDepartment: role, securityLevel: maxSecurityLevel(candidates.map((candidate) => candidate.securityLevel)), effectiveDate: candidates.map((candidate) => candidate.effectiveDate).sort().at(-1) ?? "unknown", text: candidates.map((candidate) => `[${candidate.id}]\n[tags: ${(candidate.tags ?? []).join(", ")}]\n${candidate.text}`).join("\n\n"), requiredConcepts: concepts, conceptAliases: aliases, sourceEvidenceIds: ids };
}
function maxSecurityLevel(levels) { const order = ["public", "internal", "confidential", "personal"]; return levels.sort((left, right) => order.indexOf(right) - order.indexOf(left))[0] ?? "public"; }
function chooseMode(method, bundle, concepts, aliases, scenario, threshold) {
  const fixed = selectMode(method, bundle.securityLevel);
  if (fixed) return { mode: fixed, infeasible: false };
  const withoutPolicy = method === "without-policy-constraint";
  const withoutCoverage = method === "without-coverage-constraint";
  const options = modes.map((mode) => {
    const transformed = transform(bundle, mode);
    const transformedCoverage = coverage(concepts, transformed.evidence, aliases);
    const policyAllowed = withoutPolicy || allowed(bundle.securityLevel, mode, bundle.ownerDepartment, "core", "core");
    const coverageAllowed = withoutCoverage || transformedCoverage >= threshold;
    const weight = method === "without-sensitivity-criterion" ? 0 : ({ public: 1, internal: 2, confidential: 5, personal: 8 }[bundle.securityLevel]);
    const predictedMs = method === "without-network-criterion" ? 0 : scenario.latencyMs + transformed.responseBytes / scenario.bandwidthBytesPerSecond * 1000;
    const estimatedLocalProcessingMs = mode === "raw" ? 0 : mode === "metadata-only" ? 0.02 : mode === "sanitized" ? byteLength(bundle.text) * 0.002 : byteLength(bundle.text) * 0.01;
    const objective = [transformed.responseBytes * weight, predictedMs, transformed.responseBytes, estimatedLocalProcessingMs];
    const weighted = objective[0] * 0.5 + objective[1] * 0.3 + objective[2] * 0.15 + objective[3] * 0.05;
    return { mode, policyAllowed, coverageAllowed, objective, weighted };
  }).filter((option) => option.policyAllowed && option.coverageAllowed);
  const sorted = options.sort((left, right) => method === "weighted-objective" ? left.weighted - right.weighted : compareTuple(left.objective, right.objective));
  return sorted[0] ? { mode: sorted[0].mode, infeasible: false } : { mode: "metadata-only", infeasible: !withoutCoverage };
}
function compareTuple(left, right) { for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index]; return 0; }
function hashSeed(value) { return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function git(arguments_) { try { return execFileSync("git", arguments_, { encoding: "utf8" }).trim(); } catch { return "unavailable"; } }
function csv(rows) { const columns = Object.keys(rows[0] ?? {}); const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n"; }
