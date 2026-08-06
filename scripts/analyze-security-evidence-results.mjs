import { readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { seeded } from "../emulation/runtime.mjs";

const root = new URL("../data/evaluation/security-evidence/", import.meta.url);
const supplied = process.argv.slice(2).find((argument) => argument !== "--");
const names = supplied ? [] : (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const directory = supplied ? pathToFileURL(`${path.resolve(supplied)}${path.sep}`) : new URL(`${names.at(-1)}/`, root);
const traces = (await readFile(new URL("raw-traces.jsonl", directory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const config = JSON.parse(await readFile(new URL("experiment-config.json", directory), "utf8"));
const primary = traces.filter((trace) => config.methods.includes(trace.method));
const ablation = traces.filter((trace) => (config.ablations ?? []).includes(trace.method));
const querySummary = aggregate(primary, ["queryId", "method"]);
const methodScenario = aggregate(primary, ["method", "scenario"]);
const methodSummary = summarizeQueryClusters(querySummary, config.methods);
const modeDistribution = counts(primary, ["method", "selectedMode"]);
const paired = pairedBootstrap(primary, "axnetcc-saea", config.methods.filter((method) => method !== "axnetcc-saea"), 20260806, 10000);
const ablationQuerySummary = aggregate(ablation, ["queryId", "method"]);
const ablationMethodSummary = summarizeQueryClusters(ablationQuerySummary, config.ablations ?? []);
const ablationPaired = ablation.length
  ? pairedBootstrap(ablation, "axnetcc-saea-full", (config.ablations ?? []).filter((method) => method !== "axnetcc-saea-full"), 20260806, 10000)
  : [];
await writeFile(new URL("query-summary.csv", directory), csv(querySummary));
await writeFile(new URL("method-summary.csv", directory), csv(methodSummary));
await writeFile(new URL("method-scenario-summary.csv", directory), csv(methodScenario));
await writeFile(new URL("mode-distribution.csv", directory), csv(modeDistribution));
await writeFile(new URL("paired-differences.json", directory), JSON.stringify({ seed: 20260806, resamples: 10000, cluster: "queryId", comparisons: paired }, null, 2));
await writeFile(new URL("ablation-query-summary.csv", directory), csv(ablationQuerySummary));
await writeFile(new URL("ablation-method-summary.csv", directory), csv(ablationMethodSummary));
await writeFile(new URL("ablation-paired-differences.json", directory), JSON.stringify({ seed: 20260806, resamples: 10000, cluster: "queryId", comparisons: ablationPaired }, null, 2));
const report = reportMarkdown(config, methodScenario, methodSummary, ablationMethodSummary, paired, ablationPaired, traces);
await writeFile(new URL("REPORT.md", directory), report);
console.log(new URL("REPORT.md", directory).pathname);

function aggregate(rows, keys) {
  const groups = Map.groupBy(rows, (row) => keys.map((key) => row[key]).join("\u0000"));
  return [...groups.values()].map((items) => {
    const expectedItems = items.filter((item) => item.expectedRole !== false);
    const transferredItems = items.filter((item) => !item.routingMiss);
    const base = Object.fromEntries(keys.map((key) => [key, items[0][key]]));
    const latencies = transferredItems.map((item) => item.elapsedMs).sort((a, b) => a - b);
    return {
      ...base,
      traces: items.length,
      transferredTraces: transferredItems.length,
      policyViolationRate: mean(items, "policyViolation"),
      coverage: mean(expectedItems, "coverage"),
      labelBasedCoverage: mean(expectedItems, "labelBasedCoverage"),
      runtimeProxyCoverage: mean(expectedItems, "runtimeProxyCoverage"),
      roleEvidenceCompletionRate: mean(expectedItems, "roleEvidenceComplete"),
      routingMissRate: expectedItems.filter((item) => item.routingMiss === true).length / Math.max(expectedItems.length, 1),
      agentFanOut: agentFanOut(items),
      infeasibleRoleRate: mean(expectedItems, "infeasibleRole"),
      meanLatencyMs: mean(transferredItems, "elapsedMs"),
      p50LatencyMs: quantile(latencies, 0.5),
      p95LatencyMs: quantile(latencies, 0.95),
      deadlineSatisfaction: mean(expectedItems, "deadlineSatisfied"),
      requestBytes: mean(items, "requestBytes"),
      responseBytes: mean(items, "responseBytes"),
      crossBoundaryBytes: mean(items, "crossBoundaryBytes"),
      rawCrossBoundaryBytes: mean(items, "rawCrossBoundaryBytes"),
      sensitivityWeightedCrossBoundaryBytes: mean(items, "sensitivityWeightedCrossBoundaryBytes"),
      rawReceivingZoneCount: meanRunUniqueCount(items, (item) => item.selectedMode === "raw" && item.crossBoundaryBytes > 0),
      networkDelayMs: mean(transferredItems, "networkDelayMs"),
      localProcessingMs: mean(transferredItems, "localProcessingMs"),
      httpFailureRate: mean(transferredItems, "httpFailure"),
      retryRate: transferredItems.filter((item) => item.retries > 0).length / Math.max(transferredItems.length, 1),
      removedSensitiveFieldCount: sum(items, "removedSensitiveFieldCount"),
      meanRemovedSensitiveFieldCount: meanRunSum(items, "removedSensitiveFieldCount"),
      policyRejectionCount: sum(items, "policyRejectionCount"),
      meanPolicyRejectionCount: meanRunSum(items, "policyRejectionCount"),
      coverageRejectionCount: sum(items, "coverageRejectionCount"),
      meanCoverageRejectionCount: meanRunSum(items, "coverageRejectionCount"),
      fallbackCount: sum(items, "fallbackCount"),
      meanFallbackCount: meanRunSum(items, "fallbackCount"),
    };
  });
}
function pairedBootstrap(rows, proposed, baselines, seed, resamples) {
  const metrics = ["policyViolation", "coverage", "roleEvidenceComplete", "p95LatencyMs", "rawCrossBoundaryBytes", "sensitivityWeightedCrossBoundaryBytes"];
  const byQuery = Map.groupBy(rows, (row) => row.queryId); const queryIds = [...byQuery.keys()]; const random = seeded(seed); const output = [];
  for (const baseline of baselines) for (const metric of metrics) {
    const differences = queryIds.map((queryId) => {
      const cluster = byQuery.get(queryId);
      return metricValue(cluster.filter((item) => item.method === proposed), metric) - metricValue(cluster.filter((item) => item.method === baseline), metric);
    });
    const samples = Array.from({ length: resamples }, () => meanValues(Array.from({ length: queryIds.length }, () => differences[Math.floor(random() * differences.length)]))).sort((a, b) => a - b);
    output.push({ baseline, metric, queries: queryIds.length, estimate: meanValues(differences), ci95: [quantile(samples, 0.025), quantile(samples, 0.975)], pairedPermutationP: pairedSignFlipP(differences, seed) });
  }
  return applyHolm(output);
}
function counts(rows, keys) { const groups = Map.groupBy(rows, (row) => keys.map((key) => row[key]).join("\u0000")); return [...groups.values()].map((items) => ({ ...Object.fromEntries(keys.map((key) => [key, items[0][key]])), count: items.length, share: items.length / rows.filter((row) => row.method === items[0].method).length })); }
function mean(rows, key) { return meanValues(rows.map((row) => Number(row[key]))); }
function metricMean(rows, key) { return rows.length ? mean(rows, key) : 0; }
function metricValue(rows, key) {
  const comparable = key === "coverage" || key === "roleEvidenceComplete"
    ? rows.filter((row) => row.expectedRole !== false)
    : key === "p95LatencyMs"
      ? rows.filter((row) => !row.routingMiss)
      : rows;
  if (key === "p95LatencyMs") return quantile(comparable.map((row) => Number(row.elapsedMs)).sort((a, b) => a - b), 0.95);
  return metricMean(comparable, key);
}
function pairedSignFlipP(differences, seed) {
  const observed = Math.abs(meanValues(differences));
  const combinations = differences.length <= 20 ? 2 ** differences.length : 100000;
  const random = seeded(seed ^ differences.length);
  let extreme = 0;
  for (let sample = 0; sample < combinations; sample += 1) {
    const signed = differences.map((difference, index) => {
      const positive = differences.length <= 20 ? Boolean(sample & (2 ** index)) : random() >= 0.5;
      return positive ? difference : -difference;
    });
    if (Math.abs(meanValues(signed)) >= observed - Number.EPSILON) extreme += 1;
  }
  return differences.length <= 20 ? extreme / combinations : (extreme + 1) / (combinations + 1);
}
function applyHolm(rows) {
  const groups = Map.groupBy(rows, (row) => row.metric);
  for (const group of groups.values()) {
    const ranked = [...group].sort((left, right) => left.pairedPermutationP - right.pairedPermutationP);
    let previous = 0;
    ranked.forEach((row, index) => {
      previous = Math.max(previous, Math.min(1, row.pairedPermutationP * (ranked.length - index)));
      row.holmAdjustedP = previous;
    });
  }
  return rows;
}
function summarizeQueryClusters(rows, methods) {
  const numeric = ["policyViolationRate", "coverage", "labelBasedCoverage", "runtimeProxyCoverage", "roleEvidenceCompletionRate", "routingMissRate", "agentFanOut", "infeasibleRoleRate", "meanLatencyMs", "p50LatencyMs", "p95LatencyMs", "deadlineSatisfaction", "requestBytes", "responseBytes", "crossBoundaryBytes", "rawCrossBoundaryBytes", "sensitivityWeightedCrossBoundaryBytes", "rawReceivingZoneCount", "meanRemovedSensitiveFieldCount", "networkDelayMs", "localProcessingMs", "httpFailureRate", "retryRate", "meanPolicyRejectionCount", "meanCoverageRejectionCount", "meanFallbackCount"];
  return methods.map((method) => {
    const clusters = rows.filter((row) => row.method === method);
    return { method, queries: clusters.length, ...Object.fromEntries(numeric.map((key) => [key, mean(clusters, key)])) };
  });
}
function agentFanOut(rows) {
  const runs = Map.groupBy(rows, (row) => [row.queryId, row.scenario, row.profileSeed, row.repetition].join("\u0000"));
  return meanValues([...runs.values()].map((items) => new Set(items.filter((item) => !item.routingMiss).map((item) => item.ownerDepartment)).size));
}
function meanRunUniqueCount(rows, predicate) {
  const runs = Map.groupBy(rows, (row) => [row.queryId, row.scenario, row.profileSeed, row.repetition].join("\u0000"));
  return meanValues([...runs.values()].map((items) => new Set(items.filter(predicate).map((item) => item.ownerDepartment)).size));
}
function meanRunSum(rows, key) {
  const runs = Map.groupBy(rows, (row) => [row.queryId, row.scenario, row.profileSeed, row.repetition].join("\u0000"));
  return meanValues([...runs.values()].map((items) => sum(items, key)));
}
function meanValues(values) { return values.reduce((sumValue, value) => sumValue + value, 0) / Math.max(values.length, 1); }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key]), 0); }
function quantile(values, probability) { if (!values.length) return 0; return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * probability) - 1))]; }
function csv(rows) { const columns = Object.keys(rows[0] ?? {}); const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n"; }
function reportMarkdown(runConfig, summaries, methodRows, ablationRows, comparisons, ablationComparisons, allTraces) {
  const scenarioRows = summaries.filter((row) => row.method === "axnetcc-saea"); const overall = methodRows.find((row) => row.method === "axnetcc-saea") ?? aggregate(allTraces.filter((trace) => trace.method === "axnetcc-saea"), ["method"])[0];
  const mainTable = markdownTable(methodRows);
  const ablationTable = markdownTable(ablationRows);
  return `# AXNetCC-SAEA experiment report\n\n## Configuration\n\n- Mode: ${runConfig.mode ?? "evidence-mode-comparison"}\n- Queries: ${runConfig.queries}\n- Methods: ${runConfig.methods.length}\n- Scenarios: ${runConfig.scenarios.length}\n- Repetitions: ${runConfig.repetitions}\n- Profile seeds: ${runConfig.profileSeeds.join(", ")}\n- Execution concurrency: ${runConfig.concurrency ?? 1}\n- Ablation repetitions per profile: ${runConfig.ablationRepetitions ?? 0}\n- Total HTTP traces (including ablations): ${runConfig.totalTraces}\n- Query-cluster bootstrap: 10,000 resamples, seed 20260806\n- Paired sign-flip/permutation test with Holm correction per metric\n\n## Main results\n\nAXNetCC-SAEA overall: policy violation rate ${fmt(overall.policyViolationRate)}, source-bundle coverage ${fmt(overall.labelBasedCoverage)}, runtime-proxy coverage ${fmt(overall.runtimeProxyCoverage)}, required-role completion ${fmt(overall.roleEvidenceCompletionRate)}, routing-miss rate ${fmt(overall.routingMissRate)}, mean agent fan-out ${fmt(overall.agentFanOut)}, infeasible-role rate ${fmt(overall.infeasibleRoleRate)}, P95 latency ${fmt(overall.p95LatencyMs)} ms, raw cross-boundary bytes ${fmt(overall.rawCrossBoundaryBytes)}, sensitivity-weighted bytes ${fmt(overall.sensitivityWeightedCrossBoundaryBytes)}.\n\n${mainTable}\n\n${scenarioRows.map((row) => `- ${row.scenario}: P95 ${fmt(row.p95LatencyMs)} ms; source coverage ${fmt(row.labelBasedCoverage)}; runtime coverage ${fmt(row.runtimeProxyCoverage)}; required-role completion ${fmt(row.roleEvidenceCompletionRate)}; routing misses ${fmt(row.routingMissRate)}; fan-out ${fmt(row.agentFanOut)}; policy violations ${fmt(row.policyViolationRate)}; HTTP failures ${fmt(row.httpFailureRate)}`).join("\n")}\n\nCoverage and completion are evaluated only for golden-required roles. Payload, exposure, and policy metrics include every selected role, so unnecessary fan-out is not hidden. Corpus and golden inputs are valid UTF-8. Semantic aliases bridge terminology variants, not damaged bytes. Source-bundle coverage is measured on greedily retrieved existing evidence IDs; runtime-proxy coverage is measured independently on the transformed HTTP response. Metadata transferred for an infeasible role is escalation metadata, not accepted evidence. Paired bootstrap results are in \`paired-differences.json\` (${comparisons.length} metric comparisons). Repeated executions of the same query are never treated as independent queries.\n\n## Ablations\n\n${ablationTable || "No ablation traces were requested."}\n\nAblation traces are not pooled with primary-method summaries. Paired results are in \`ablation-paired-differences.json\` (${ablationComparisons.length} comparisons).\n\n## Claim boundaries\n\n- Synthetic security emulation profile (\`syntheticProfile: true\`).\n- Public and synthetic source data; no assertion that public documents carry real security labels.\n- Application-layer HTTP emulation and measured application payload bytes/elapsed time.\n- No physical KOREN measurement and no packet-level wire-byte claim.\n- No legal-compliance or privacy guarantee.\n- No expert validation of final business correctness.\n\n## Limitations\n\nThe six-query full run estimates within-set systems effects; it is not a broad confirmatory task benchmark. Host scheduling and the recorded concurrency affect elapsed time; injected delays and planner choices are seeded/deterministic, while observed wall-clock timing is not perfectly deterministic. Semantic aliases and role-concept assignments are derived configuration and are not independent human adjudication.\n`;
}
function fmt(value) { return Number(value ?? 0).toFixed(3); }
function markdownTable(rows) {
  if (!rows.length) return "";
  const header = "| Method | Completion | Policy violation | Runtime coverage | P95 ms | Raw bytes | Weighted bytes |";
  const divider = "| --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  return [header, divider, ...rows.map((row) => `| ${row.method} | ${fmt(row.roleEvidenceCompletionRate)} | ${fmt(row.policyViolationRate)} | ${fmt(row.runtimeProxyCoverage)} | ${fmt(row.p95LatencyMs)} | ${fmt(row.rawCrossBoundaryBytes)} | ${fmt(row.sensitivityWeightedCrossBoundaryBytes)} |`)].join("\n");
}
