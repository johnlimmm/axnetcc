import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const supplied = process.argv.slice(2).find((argument) => argument !== "--");
if (!supplied) throw new Error("Pass the completed security-evidence run directory.");
const directory = pathToFileURL(`${path.resolve(supplied)}${path.sep}`);
const config = JSON.parse(await readFile(new URL("experiment-config.json", directory), "utf8"));
const traces = (await readFile(new URL("raw-traces.jsonl", directory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const datasetText = await readFile(new URL(`../${config.datasetPath}`, import.meta.url), "utf8");
const cases = datasetText.trim().split(/\r?\n/).map(JSON.parse).slice(0, config.queries);
const corpusText = await readFile(new URL("../data/rag-corpus.json", import.meta.url), "utf8");
const scenariosText = await readFile(new URL("../emulation/scenarios.json", import.meta.url), "utf8");
const securityText = await readFile(new URL("../data/security-evidence-manifest.json", import.meta.url), "utf8");
const failures = [];

check(config.datasetSha256 === sha(datasetText), "dataset SHA-256 mismatch");
check(config.corpusSha256 === sha(corpusText), "corpus SHA-256 mismatch");
check(config.scenariosSha256 === sha(scenariosText), "scenario SHA-256 mismatch");
check(config.securityManifestSha256 === sha(securityText), "security manifest SHA-256 mismatch");
check(traces.length === config.totalTraces, `trace count mismatch: ${traces.length} != ${config.totalTraces}`);
check(new Set(traces.map((trace) => trace.traceId)).size === traces.length, "duplicate traceId detected");

const expectedJobs = config.queries * config.scenarios.length * config.profileSeeds.length * (config.methods.length * config.repetitions + (config.ablations?.length ?? 0) * (config.ablationRepetitions ?? 0));
const completedJobsText = await readFile(new URL("completed-jobs.jsonl", directory), "utf8");
const completedJobs = completedJobsText.trim().split(/\r?\n/).filter(Boolean);
check(completedJobs.length === expectedJobs, `completed job count mismatch: ${completedJobs.length} != ${expectedJobs}`);
check(new Set(completedJobs).size === completedJobs.length, "duplicate completed job key detected");

if (!config.mode.startsWith("routing")) {
  const grouped = Map.groupBy(traces, (trace) => [trace.queryId, trace.method, trace.scenario, trace.profileSeed, trace.repetition].join("\u0000"));
  for (const item of cases) {
    for (const method of [...config.methods, ...(config.ablations ?? [])]) {
      const reps = (config.ablations ?? []).includes(method) ? config.ablationRepetitions : config.repetitions;
      for (const scenario of config.scenarios) for (const seed of config.profileSeeds) for (let repetition = 0; repetition < reps; repetition += 1) {
        const key = [item.id, method, scenario, seed, repetition].join("\u0000");
        const rows = grouped.get(key) ?? [];
        check(rows.length === item.expected_agents.length, `role trace count mismatch for ${key}: ${rows.length} != ${item.expected_agents.length}`);
      }
    }
  }
}

for (const trace of traces) {
  if (trace.policyViolation) check(trace.policyBypassForExperiment === true, `violation lacks experiment bypass marker: ${trace.traceId}`);
  if (trace.method === "axnetcc-saea" || trace.method === "axnetcc-saea-full") check(trace.policyViolation === false, `SAEA policy violation: ${trace.traceId}`);
  if (trace.selectedMode === "metadata-only") check(trace.runtimeProxyCoverage === 0, `metadata-only has runtime coverage: ${trace.traceId}`);
  check(Number.isFinite(trace.elapsedMs) && trace.elapsedMs >= 0, `invalid elapsed time: ${trace.traceId}`);
  check(Number.isFinite(trace.requestBytes) && trace.requestBytes >= 0, `invalid request bytes: ${trace.traceId}`);
}

const profileLevels = Object.fromEntries(config.profileSeeds.map((seed) => [seed, [...new Set(traces.filter((trace) => trace.profileSeed === seed).map((trace) => trace.securityLevel))].sort()]));
check(new Set(Object.values(profileLevels).map(JSON.stringify)).size > 1, "synthetic security profiles are not observably distinct");

const report = { valid: failures.length === 0, checkedAt: new Date().toISOString(), runId: config.runId, expectedJobs, traces: traces.length, uniqueQueries: new Set(traces.map((trace) => trace.queryId)).size, profileLevels, policyViolations: traces.filter((trace) => trace.policyViolation).length, transportFailures: traces.filter((trace) => trace.httpStatus === 599).length, failures };
await writeFile(new URL("INTEGRITY_REPORT.json", directory), JSON.stringify(report, null, 2));
if (failures.length) throw new Error(`Integrity validation failed with ${failures.length} issue(s). See INTEGRITY_REPORT.json.`);
console.log(JSON.stringify(report, null, 2));

function check(condition, message) { if (!condition) failures.push(message); }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
