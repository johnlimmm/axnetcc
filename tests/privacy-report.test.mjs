import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PRIVACY_REPORT_SCHEMA_VERSION,
  PRIVACY_RISK_VERSION,
  PrivacyReportSchemaError,
  assertCompatiblePrivacyReports,
  assertPrivacyRowsV2,
  normalizePrivacyBreakdownV2,
  privacyExposureState,
  summarizePrivacyRowsV2,
} from "../scripts/privacy-report-contract.mjs";

const root = new URL("../", import.meta.url);
const workerEnvironment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const workerContext = { waitUntil() {}, passThroughOnException() {} };

async function renderEvaluationPage() {
  const workerUrl = new URL("dist/server/index.js", root);
  workerUrl.searchParams.set("evaluation-contract", `${process.pid}-${Date.now()}-${Math.random()}`);
  const runtime = (await import(workerUrl.href)).default;
  const response = await runtime.fetch(
    new Request("http://localhost/evaluation", { headers: { accept: "text/html" } }),
    workerEnvironment,
    workerContext,
  );
  assert.equal(response.status, 200);
  return response.text();
}

function breakdown(overrides = {}) {
  return {
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    score: 8,
    sensitiveDetectedCount: 0,
    sensitiveTransmittedCount: 0,
    sensitiveTransmissionRatio: 0,
    selectedAgentCount: 1,
    totalAgentCount: 4,
    agentSelectionRatio: 0.25,
    originalBytes: 100,
    transmittedOriginalBytes: 0,
    originalDisclosureRatio: 0,
    rawDataLeavesEdge: false,
    egressEnvelopeCount: 1,
    recipientCount: 1,
    privacyPass: true,
    outputLeak: false,
    diagnostics: [],
    ...overrides,
  };
}

function metrics(overrides = {}) {
  const privacyRisk = breakdown(overrides);
  return {
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    privacyRiskScore: privacyRisk.score,
    privacyRisk,
  };
}

function row(overrides = {}) {
  return {
    id: "case",
    mode: "proposed",
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    privacyRisk: breakdown(overrides),
  };
}

test("API v2 privacy score and full S/A/O breakdown are preserved", () => {
  const input = metrics({
    score: 41,
    sensitiveDetectedCount: 2,
    sensitiveTransmittedCount: 1,
    sensitiveTransmissionRatio: 0.5,
    transmittedOriginalBytes: 40,
    originalDisclosureRatio: 0.4,
  });
  const normalized = normalizePrivacyBreakdownV2(input, "fixture.metrics");

  assert.equal(normalized.score, input.privacyRiskScore);
  assert.equal(normalized.sensitiveTransmissionRatio, 0.5);
  assert.equal(normalized.agentSelectionRatio, 0.25);
  assert.equal(normalized.originalDisclosureRatio, 0.4);
  assert.deepEqual(normalized, input.privacyRisk);
});

test("exposure states distinguish no detection, full masking, and exposure", () => {
  const noDetection = row();
  const fullyMasked = row({
    score: 21,
    sensitiveDetectedCount: 2,
    sensitiveTransmittedCount: 0,
    sensitiveTransmissionRatio: 0,
    selectedAgentCount: 2,
    agentSelectionRatio: 0.5,
    transmittedOriginalBytes: 30,
    originalDisclosureRatio: 0.3,
  });
  const exposure = row({
    score: 41,
    sensitiveDetectedCount: 2,
    sensitiveTransmittedCount: 1,
    sensitiveTransmissionRatio: 0.5,
    transmittedOriginalBytes: 40,
    originalDisclosureRatio: 0.4,
    privacyPass: false,
    outputLeak: true,
  });

  assert.equal(privacyExposureState(noDetection.privacyRisk), "sensitive-not-detected");
  assert.equal(privacyExposureState(fullyMasked.privacyRisk), "detected-fully-masked");
  assert.equal(privacyExposureState(exposure.privacyRisk), "sensitive-exposure");

  const summary = summarizePrivacyRowsV2([noDetection, fullyMasked, exposure]);
  assert.equal(summary.averageScore, 23.3);
  assert.deepEqual(summary.exposureStates, {
    sensitiveNotDetected: 1,
    detectedFullyMasked: 1,
    sensitiveExposure: 1,
  });
  assert.equal(summary.sensitiveTransmission.averageRatio, 0.167);
  assert.equal(summary.agentSelection.averageRatio, 0.333);
  assert.equal(summary.originalDisclosure.averageRatio, 0.233);
});

test("mixed v1/v2 rows fail before aggregation", () => {
  assert.throws(
    () => assertPrivacyRowsV2([
      row(),
      { ...row(), privacyRiskVersion: "v1" },
    ], "mixed rows"),
    (error) => error instanceof PrivacyReportSchemaError && /Cannot aggregate mixed/.test(error.message),
  );
});

test("mixed v1/v2 reports fail before comparison", () => {
  assert.throws(
    () => assertCompatiblePrivacyReports([
      { privacyRiskVersion: "v2" },
      { privacyRiskVersion: "v1-proxy-unversioned" },
    ], "dashboard reports"),
    (error) => error instanceof PrivacyReportSchemaError && /Cannot combine v1 and v2/.test(error.message),
  );
});

test("measured pilot report contains 24 API-backed v2 rows", async () => {
  const report = JSON.parse(await readFile(
    new URL("data/evaluation/latest-report-v2.json", root),
    "utf8",
  ));
  assert.equal(report.schemaVersion, PRIVACY_REPORT_SCHEMA_VERSION);
  assert.equal(report.privacyRiskVersion, PRIVACY_RISK_VERSION);
  assert.equal(report.status, "measured");
  assert.equal(report.expectedRuns, 24);
  assert.equal(report.completedRuns, 24);
  assert.equal(report.rows.length, 24);
  assertPrivacyRowsV2(report.rows, "measured pilot rows");
  for (const summary of Object.values(report.modes)) {
    assert.equal(summary.averagePrivacyRiskScore, summary.privacyRisk.averageScore);
    assert.equal(summary.privacyRisk.privacyRiskVersion, PRIVACY_RISK_VERSION);
  }
});

const evaluationModes = ["centralized", "parallel", "masrouter", "remoterag", "proposed"];

function assertReportHeaderV2(report) {
  assert.equal(report.schemaVersion, PRIVACY_REPORT_SCHEMA_VERSION);
  assert.equal(report.privacyRiskVersion, PRIVACY_RISK_VERSION);
}

function assertRowsHaveFullV2Privacy(rows, label) {
  assertPrivacyRowsV2(rows, label);
  for (const [index, item] of rows.entries()) {
    const normalized = normalizePrivacyBreakdownV2({
      privacyRiskVersion: item.privacyRiskVersion,
      privacyRiskScore: item.privacyRisk?.score,
      privacyRisk: item.privacyRisk,
    }, `${label}[${index}]`);
    assert.deepEqual(normalized, item.privacyRisk);
  }
}

function assertPendingReportHasNoEstimatedPrivacy(report, summaryField) {
  assert.equal(report.status, "pending-replay");
  assert.equal(report.completedRuns, 0);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report[summaryField], summaryField === "summary" ? [] : {});
  assert.equal(report.legacyReport.eligibleForV2Aggregation, false);

  const forbiddenEstimateFields = new Set([
    "averagePrivacyRiskScore",
    "privacyRisk",
    "privacyRiskScore",
  ]);
  const visit = (value, path = "report") => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        forbiddenEstimateFields.has(key),
        false,
        `${path}.${key} must not contain an estimated privacy value while replay is pending`,
      );
      visit(child, `${path}.${key}`);
    }
  };
  visit(report);
}

test("expanded report is either an estimate-free pending shell or a complete 40×5 v2 measurement", async () => {
  const report = JSON.parse(await readFile(
    new URL("data/evaluation/expanded-report-v2.json", root),
    "utf8",
  ));
  assertReportHeaderV2(report);
  assert.equal(report.cases, 40);
  assert.equal(report.expectedRuns, 200);

  if (report.status === "pending-replay") {
    assertPendingReportHasNoEstimatedPrivacy(report, "summaries");
    return;
  }

  assert.equal(report.status, "measured");
  assert.equal(report.completedRuns, 200);
  assert.equal(report.runs, 200);
  assert.equal(report.rows.length, 200);
  assertRowsHaveFullV2Privacy(report.rows, "expanded measured rows");

  assert.equal(new Set(report.rows.map((item) => item.id)).size, 40);
  assert.deepEqual([...new Set(report.rows.map((item) => item.mode))].sort(), evaluationModes.slice().sort());
  assert.equal(
    new Set(report.rows.map((item) => `${item.id}/${item.mode}`)).size,
    200,
    "every expanded case/mode combination must appear exactly once",
  );
  for (const mode of evaluationModes) {
    const modeRows = report.rows.filter((item) => item.mode === mode);
    assert.equal(modeRows.length, 40, `${mode} must have exactly one row per expanded case`);
    const summary = report.summaries[mode];
    assert.ok(summary, `${mode} summary is required`);
    assert.equal(summary.n, 40);
    assert.equal(summary.privacyRisk.privacyRiskVersion, PRIVACY_RISK_VERSION);
    assert.equal(summary.privacyRisk.sampleSize, 40);
    assert.equal(summary.averagePrivacyRiskScore, summary.privacyRisk.averageScore);
  }
});

test("repeat report is either estimate-free pending or a complete 3×5×5 v2 replay with truthful judge status", async () => {
  const report = JSON.parse(await readFile(
    new URL("data/evaluation/repeat-benchmark-report-v2.json", root),
    "utf8",
  ));
  assertReportHeaderV2(report);
  assert.equal(report.repetitions, 3);
  assert.equal(report.queries, 5);
  assert.equal(report.expectedRuns, 75);

  if (report.status === "pending-replay") {
    assertPendingReportHasNoEstimatedPrivacy(report, "summary");
    assert.equal(report.completedJudgeRuns, 0);
    return;
  }

  assert.ok(["measured", "partial"].includes(report.status));
  assert.equal(report.completedRuns, 75);
  assert.equal(report.runs, 75);
  assert.equal(report.rows.length, 75);
  assertRowsHaveFullV2Privacy(report.rows, "repeat benchmark rows");

  const combinations = new Set();
  for (const item of report.rows) {
    assert.ok(Number.isInteger(item.repetition) && item.repetition >= 1 && item.repetition <= 3);
    assert.ok(Number.isInteger(item.query) && item.query >= 1 && item.query <= 5);
    assert.ok(evaluationModes.includes(item.mode));
    combinations.add(`${item.repetition}/${item.query}/${item.mode}`);
  }
  assert.equal(combinations.size, 75, "every repetition/query/mode combination must appear exactly once");

  const completedJudgeRuns = report.rows.filter((item) => Number.isFinite(item.overall)).length;
  assert.equal(report.completedJudgeRuns, completedJudgeRuns);
  assert.equal(report.status, completedJudgeRuns === 75 ? "measured" : "partial");
  assert.equal(report.summary.length, evaluationModes.length);
  for (const mode of evaluationModes) {
    const summary = report.summary.find((item) => item.mode === mode);
    assert.ok(summary, `${mode} summary is required`);
    assert.equal(summary.n, 15);
    assert.equal(summary.privacyRisk.privacyRiskVersion, PRIVACY_RISK_VERSION);
    assert.equal(summary.privacyRisk.sampleSize, 15);
    assert.equal(summary.averagePrivacyRiskScore, summary.privacyRisk.averageScore);
  }
});

test("evaluation page reads versioned reports instead of hardcoded result arrays", async () => {
  const source = await readFile(new URL("app/evaluation/page.tsx", root), "utf8");
  assert.match(source, /latest-report-v2\.json/);
  assert.match(source, /expanded-report-v2\.json/);
  assert.match(source, /repeat-benchmark-report-v2\.json/);
  assert.match(source, /LatestRunEvaluation/);
  assert.match(source, /offline-performance-table/);
  assert.match(source, /expanded-safety-table/);
  assert.match(source, /repeat-detail-table/);
  for (const field of [
    "citationValidity",
    "forbiddenOutputPassRate",
    "averageLatencyMs",
    "averageBoundaryBytes",
    "ttftMs",
    "tpotMs",
  ]) {
    assert.ok(source.includes(field), `evaluation page must render ${field} from the versioned reports`);
  }
  assert.doesNotMatch(source, /const\s+(?:fixedResults|results)\s*=/);
  assert.doesNotMatch(source, /93\.8%|86\.6%|48\.2%/);
});

test("latest run evaluation reads one public run snapshot and separates all execution diagnostics", async () => {
  const source = await readFile(new URL("app/evaluation/LatestRunEvaluation.tsx", root), "utf8");
  assert.match(source, /new URLSearchParams\(window\.location\.search\)\.get\("run"\)/);
  assert.match(source, /fetch\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}`/);
  assert.match(source, /cache:\s*"no-store"/);
  assert.match(source, /setTimeout\(\(\) => void load\(\), 1_000\)/);

  for (const field of [
    "sensitiveTransmissionRatio",
    "agentSelectionRatio",
    "originalDisclosureRatio",
    "qualityScore",
    "citationCoverage",
    "citationValidity",
    "citationRecall",
    "calls",
    "tokens",
    "queueWaitMs",
    "inferenceMs",
    "boundaryBytes",
    "rankedCandidates",
    "evidencePlan",
    "coveredConceptIds",
    "missingConceptIds",
    "checks",
    "timeline",
  ]) {
    assert.ok(source.includes(field), `latest run evaluation must render ${field}`);
  }

  assert.match(source, /return finite\(value\)[\s\S]*: "—"/);
  assert.match(source, /값이 없는 항목은 추정하지 않고 —로 표시/);
});

test("built evaluation page renders status and measured values from the v2 reports", async () => {
  const [offline, expanded, repeat, html] = await Promise.all([
    readFile(new URL("data/evaluation/latest-report-v2.json", root), "utf8").then(JSON.parse),
    readFile(new URL("data/evaluation/expanded-report-v2.json", root), "utf8").then(JSON.parse),
    readFile(new URL("data/evaluation/repeat-benchmark-report-v2.json", root), "utf8").then(JSON.parse),
    renderEvaluationPage(),
  ]);
  assert.match(html, /VERSIONED PERFORMANCE EVALUATION/);
  assert.match(html, /최근 실행 성능 진단/);
  assert.match(html, /파일럿 모드별 평가/);
  assert.match(html, /40문항 × 5모드 고정 정답 평가/);
  assert.match(html, /적용 안정성 반복 벤치마크/);
  assert.match(html, /품질·인용·출력보호·운영 성능/);
  assert.match(html, /Judge·생성 지연 상세/);
  assert.ok(html.includes(String(offline.completedRuns)));
  if (expanded.status === "measured") {
    assert.ok(html.includes(expanded.summaries.proposed.objectiveQuality.toFixed(1)));
    assert.ok(html.includes(expanded.summaries.proposed.averagePrivacyRiskScore.toFixed(1)));
  } else {
    assert.match(html, /재실행 대기/);
  }
  if (repeat.status !== "pending-replay") {
    const proposed = repeat.summary.find((item) => item.mode === "proposed");
    assert.ok(proposed);
    assert.ok(html.includes(proposed.averagePrivacyRiskScore.toFixed(1)));
  } else {
    assert.match(html, /반복 평가[\s\S]*재실행 대기/);
  }
});
