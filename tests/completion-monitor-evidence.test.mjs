import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { digest } from "../scripts/evaluate-grounded-completion.mjs";
import { readCompletionEvidence, startMonitor } from "../monitor/server.mjs";

const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];

// Synthetic schema fixtures only. These are NOT acceptance questions or semantic judgments.
function fixture(directory, failedCount = 0) {
  const hash = digest("synthetic-only"), cases = roles.flatMap(role => Array.from({ length: 5 }, (_, i) => ({ id: `${role}-${i}`, role, kind: "answerable", query: `PRIVATE-QUESTION ${role} ${i}`, rubricHash: hash })));
  cases.push(...Array.from({ length: 10 }, (_, i) => ({ id: `safety-${i}`, role: roles[i % 8], kind: i < 6 ? "mixed" : "unsupported", query: `PRIVATE-QUESTION safety ${i}`, rubricHash: hash })));
  const manifest = { schemaVersion: "grounded-completion/v1", deploymentId: "synthetic-demo", authorId: "author", runtimeAuthorId: "runtime", concurrency: 3, deadlineMs: 60000, watchdogMs: 70000, maximumRequests: 180, maximumWallMs: 7200000, seed: 17, frozenAt: "2026-01-01T00:00:00Z", configurationHash: hash, rubricHash: hash, workloadHash: digest(JSON.stringify(cases)), cases, readiness: { policy: "admit-cold", description: "PRIVATE-FREE-TEXT" }, artifacts: ["build", "corpus", "prompts", "models", "configuration", "rubrics"].map(kind => ({ kind, path: `PRIVATE-PATH/${kind}.json`, sha256: hash })) };
  const samples = cases.map((c, i) => ({ caseId: c.id, occurrence: 1, status: i < failedCount ? "failed" : "completed", hasFinal: i >= failedCount, elapsedMs: 1000, transcriptComplete: true, computeCompletionProven: true, answerRendering: i % 2 ? "source-grounded-generation" : "model-guided-extractive", result: { conclusion: "PRIVATE-RESPONSE" } }));
  const manifestBytes = JSON.stringify(manifest), sampleBytes = samples.map(s => JSON.stringify(s)).join("\n");
  const grades = { schemaVersion: "grounded-grades/v1", reviewType: "AI-assisted", graderId: "grader", adjudicatorId: "adjudicator", workloadHash: manifest.workloadHash, rubricHash: hash, samplesHash: digest(sampleBytes), auditMissedUnsupportedClaim: false, cases: cases.map(c => ({ id: c.id, rubricHash: hash, F: true, C: true, U: true, safe: true, visibleClaimsSafe: true, reason: "PRIVATE-GRADE", claims: [{ text: "PRIVATE-CLAIM", support: "supported", sourceSpans: ["PRIVATE-SPAN"] }], adjudicated: true, adjudicationReason: "synthetic", disagreementResolved: true })) };
  const report = { schemaVersion: "grounded-completion-report/v1", manifestFile: "manifest.json", manifestHash: digest(manifestBytes), samplesFile: "samples.jsonl", samplesHash: digest(sampleBytes), stopReason: null, interruption: null, cleanup: [{ faultsRestored: true, cancellationConfirmed: true, transportDrained: true }], summary: { qualityLatencyPassed: true, fullCompletionProven: true }, secret: "PRIVATE-TOKEN", startedWithFrozenConfiguration: hash };
  writeFileSync(join(directory, "manifest.json"), manifestBytes); writeFileSync(join(directory, "samples.jsonl"), sampleBytes);
  writeFileSync(join(directory, "report.json"), JSON.stringify(report)); writeFileSync(join(directory, "grades.json"), JSON.stringify(grades));
  return { reportPath: join(directory, "report.json"), gradesPath: join(directory, "grades.json"), report, grades };
}

function withFixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), "completion-monitor-synthetic-"));
  return Promise.resolve().then(() => fn(directory)).finally(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + "\\") || resolve(directory).startsWith(resolve(tmpdir()) + "/"));
    rmSync(directory, { recursive: true, force: true });
  });
}

test("verified cohort summary is sanitized and never upgrades D/M/U/V to complete", () => withFixture(directory => {
  const { reportPath, gradesPath } = fixture(directory);
  const evidence = readCompletionEvidence(reportPath, gradesPath);
  assert.equal(evidence.status, "passed"); assert.equal(evidence.bindingVerified, true);
  assert.deepEqual(evidence.gates, { Q1: "passed", Q2: "passed", Q3: "passed", P1: "passed" });
  assert.deepEqual(evidence.quality, { answerablePassed: 40, primaryDenominator: 40, safetyPassed: 10, safetyDenominator: 10 });
  assert.deepEqual(evidence.roleScores.tech, { passed: 5, denominator: 5 });
  assert.equal(evidence.fullCompletionProven, false);
  assert.ok(Object.values(evidence.remainingGates).every(value => value === "unproven"));
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE-|path|secret|query|claims/i);
  assert.equal(evidence.outcomes.extractive, 25); assert.equal(evidence.outcomes.generated, 25);
  assert.equal(evidence.hashes.report, digest(readFileSync(reportPath)));
}));

test("missing grades stay pending rather than displaying zero quality or a forged report PASS", () => withFixture(directory => {
  const { reportPath } = fixture(directory);
  const evidence = readCompletionEvidence(reportPath);
  assert.equal(evidence.status, "pending"); assert.equal(evidence.gates.Q1, "pending");
  assert.equal(evidence.quality.answerablePassed, null); assert.equal(evidence.roleScores.tech.passed, null);
  assert.equal(evidence.gates.P1, "passed"); assert.equal(evidence.fullCompletionProven, false);
  assert.equal(readCompletionEvidence().status, "pending");
}));

test("failures keep fixed denominators and infinity-censored latency", () => withFixture(directory => {
  const { reportPath, gradesPath } = fixture(directory, 3);
  const evidence = readCompletionEvidence(reportPath, gradesPath);
  assert.equal(evidence.status, "failed"); assert.equal(evidence.gates.Q1, "passed"); assert.equal(evidence.gates.P1, "failed");
  assert.equal(evidence.quality.answerablePassed, 37); assert.equal(evidence.latency.denominator, 40);
  assert.equal(evidence.latency.censoredFinalCount, 3); assert.equal(evidence.latency.finalResponseP95Ms, "Infinity");
  assert.equal(evidence.latency.allTerminalP95Ms, 1000);
}));

test("tampered artifacts and grade bindings fail closed without path or error leakage", () => withFixture(directory => {
  const { reportPath, gradesPath, grades } = fixture(directory);
  grades.samplesHash = digest("wrong"); writeFileSync(gradesPath, JSON.stringify(grades));
  assert.equal(readCompletionEvidence(reportPath, gradesPath).status, "invalid");
  fixture(directory); writeFileSync(join(directory, "samples.jsonl"), "PRIVATE-TAMPERED");
  const invalid = readCompletionEvidence(reportPath, gradesPath);
  assert.equal(invalid.bindingVerified, false); assert.equal(invalid.status, "invalid");
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE|synthetic-demo|samples.jsonl/);
  assert.equal(readCompletionEvidence("relative/report.json").status, "invalid");
}));

test("read-only API rejects browser-selected paths and downloads only the sanitized verified projection", () => withFixture(async directory => {
  const { reportPath, gradesPath } = fixture(directory);
  const monitor = await startMonitor({ port: 0, database: ":memory:", completionReport: reportPath, completionGrades: gradesPath, serviceUrl: "http://source.test", fetchImpl: async () => new Response(null, { status: 503 }) });
  try {
    const response = await fetch(`${monitor.url}/api/completion/report.json`);
    assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /sanitized.json/);
    assert.doesNotMatch(await response.text(), /PRIVATE-/);
    assert.equal((await fetch(`${monitor.url}/api/completion?path=secret`)).status, 400);
    assert.equal((await fetch(`${monitor.url}/api/completion`, { method: "POST" })).status, 405);
    writeFileSync(gradesPath, "{}");
    assert.equal((await (await fetch(`${monitor.url}/api/completion`)).json()).status, "invalid");
    assert.equal((await fetch(`${monitor.url}/api/completion/report.json`)).status, 404);
  } finally { await monitor.stop(); }
}));

test("evidence panel presents cohort PASS with explicit remaining gates and stale/tampered evidence without PASS", () => withFixture(directory => {
  const { reportPath, gradesPath } = fixture(directory);
  const source = readFileSync(new URL("../monitor/public/app.js", import.meta.url), "utf8");
  const helper = source.slice(source.indexOf("function completionGateView"), source.indexOf("function distributedCallDetails"));
  const context = { completionData: readCompletionEvidence(reportPath, gradesPath), esc: value => String(value).replaceAll("<", "&lt;"), count: value => typeof value === "number" ? String(value) : "—", ms: value => `${value}ms`, agents: {} };
  vm.createContext(context); vm.runInContext(helper, context);
  const html = context.completionGateView();
  assert.match(html, /Q1 · 통과/); assert.match(html, /전체 완료는 아직 증명되지 않았습니다/); assert.match(html, /AI-assisted/);
  assert.match(html, /40 \/ 40/); assert.match(html, /미확인\/기한 초과 0 \/ 40/);
  context.completionData = { status: "invalid", bindingVerified: false };
  const failed = context.completionGateView(); assert.match(failed, /role="alert"/); assert.doesNotMatch(failed, /Q1 · 통과/);
}));


test("hybrid rendering is allowlisted configuration evidence; legacy stays unknown and mismatches fail closed", () => withFixture(directory => {
 const {reportPath,report}=fixture(directory);
 assert.deepEqual(readCompletionEvidence(reportPath).renderingConfiguration,{edge:null,core:null});
 const modes={edge:"model-guided-extractive",core:"source-grounded-generation"};
 const manifest=JSON.parse(readFileSync(join(directory,"manifest.json")));
 manifest.renderingConfiguration=modes;
 const samples=readFileSync(join(directory,"samples.jsonl"),"utf8").split("\n").map(JSON.parse);
 for(const sample of samples){sample.renderingConfiguration=modes;sample.answerRendering=modes.core;}
 const save=()=>{const mb=JSON.stringify(manifest),sb=samples.map(s=>JSON.stringify(s)).join("\n");writeFileSync(join(directory,"manifest.json"),mb);writeFileSync(join(directory,"samples.jsonl"),sb);report.manifestHash=digest(mb);report.samplesHash=digest(sb);writeFileSync(reportPath,JSON.stringify(report));};
 save();const evidence=readCompletionEvidence(reportPath);
 assert.deepEqual(evidence.renderingConfiguration,modes);assert.equal(evidence.outcomes.generated,50);assert.equal(evidence.outcomes.extractive,0);assert.equal(evidence.fullCompletionProven,false);
 assert.equal(evidence.renderingProvenance,"frozen-configuration-not-per-call-observation");
 samples[0].renderingConfiguration={...modes,edge:modes.core};save();assert.equal(readCompletionEvidence(reportPath).status,"invalid");
 samples[0].renderingConfiguration={...modes,edge:"PRIVATE-UNSAFE"};save();const bad=readCompletionEvidence(reportPath);assert.equal(bad.status,"invalid");assert.doesNotMatch(JSON.stringify(bad),/PRIVATE-UNSAFE/);
}));
