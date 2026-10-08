import assert from "node:assert/strict";
import test from "node:test";

import {
  METRIC_PROVENANCE_VERSION,
  aggregateInferenceTokenCounts,
  calculateCitationTraceability,
  calculateElapsedMetric,
  derivedMetric,
  detectExplicitClaimConflicts,
  estimatedMetric,
  measuredMetric,
  unavailableMetric,
} from "../lib/metric-provenance.ts";

test("all provenance factories emit the v2 contract and preserve their kind", () => {
  const input = { source: "fixture", method: "fixture method" };
  const readings = [
    measuredMetric(1, input),
    derivedMetric(2, input),
    estimatedMetric(3, input),
    unavailableMetric(input),
  ];

  assert.equal(METRIC_PROVENANCE_VERSION, "v2");
  assert.deepEqual(
    readings.map((reading) => reading.provenance.kind),
    ["measured", "derived", "estimated", "unavailable"],
  );
  assert.ok(readings.every((reading) => reading.provenance.version === "v2"));
  assert.equal(readings.at(-1).value, null);
});

test("token totals are emitted only when every inference has complete counters", () => {
  const complete = aggregateInferenceTokenCounts([
    { promptTokens: 12, completionTokens: 8 },
    { promptTokens: 20, completionTokens: 5 },
  ]);
  assert.deepEqual(complete.value, {
    inferenceCount: 2,
    promptTokens: 32,
    completionTokens: 13,
    totalTokens: 45,
  });
  assert.equal(complete.provenance.kind, "derived");

  const partial = aggregateInferenceTokenCounts([
    { promptTokens: 12, completionTokens: 8 },
    { promptTokens: null, completionTokens: 5 },
  ]);
  assert.equal(partial.value, null);
  assert.equal(partial.provenance.kind, "unavailable");
  assert.match(partial.provenance.detail, /partial totals are not reported/i);
});

test("empty or invalid token input stays unavailable instead of becoming zero", () => {
  assert.equal(aggregateInferenceTokenCounts([]).value, null);
  assert.equal(aggregateInferenceTokenCounts([
    { promptTokens: 2.5, completionTokens: 1 },
  ]).value, null);
  assert.equal(aggregateInferenceTokenCounts([
    { promptTokens: 2, completionTokens: -1 },
  ]).value, null);
});

test("elapsed time is the actual clock delta with no synthetic Agent delay", () => {
  const elapsed = calculateElapsedMetric(1_000, 1_347);
  assert.equal(elapsed.value, 347);
  assert.equal(elapsed.provenance.kind, "measured");
  assert.equal(elapsed.provenance.method, "completedAt - startedAt");

  const reversed = calculateElapsedMetric(1_001, 1_000);
  assert.equal(reversed.value, null);
  assert.equal(reversed.provenance.kind, "unavailable");
});

test("traceability is based on substantive claims with fully valid citations", () => {
  const traceability = calculateCitationTraceability(
    "원문 외부 전송은 금지합니다 [SEC-1].\n법무 검토가 필요합니다 [LEGAL-2].\n운영 승인이 필요합니다 [MISSING].",
    ["SEC-1", "LEGAL-2"],
  );

  assert.deepEqual(traceability.value, {
    score: 67,
    claimCount: 3,
    citedClaimCount: 3,
    validlyCitedClaimCount: 2,
    citationCount: 3,
    validCitationCount: 2,
  });
  assert.equal(traceability.provenance.kind, "derived");
  assert.match(traceability.provenance.detail, /does not.*semantic entailment/i);
});

test("traceability is unavailable when there is no substantive claim", () => {
  const traceability = calculateCitationTraceability("[SEC-1]", ["SEC-1"]);
  assert.equal(traceability.value, null);
  assert.equal(traceability.provenance.kind, "unavailable");
});

test("explicit positive and negative claims on the same topic produce a conflict", () => {
  const analysis = detectExplicitClaimConflicts([
    { agentId: "operations", text: "개인정보 원문 외부 전송을 허용한다." },
    { agentId: "security", text: "개인정보 원문 외부 전송을 금지한다." },
  ]);

  assert.equal(analysis.status, "detected");
  assert.equal(analysis.conflicts.length, 1);
  assert.deepEqual(analysis.conflicts[0].sharedTerms, ["개인정보", "외부", "원문", "전송"]);
  assert.equal(analysis.provenance.version, "v2");
  assert.equal(analysis.provenance.kind, "derived");
});

test("Agent count alone never creates a conflict", () => {
  const analysis = detectExplicitClaimConflicts([
    { agentId: "tech", text: "내부망 배포를 허용한다." },
    { agentId: "operations", text: "내부망 배포를 허용해야 한다." },
    { agentId: "legal", text: "계약 검토가 필요합니다." },
  ]);

  assert.equal(analysis.status, "none-detected");
  assert.equal(analysis.conflicts.length, 0);
  assert.equal(analysis.negativeClaimCount, 0);
});

test("opposite polarity on unrelated topics is not reported as a conflict", () => {
  const analysis = detectExplicitClaimConflicts([
    { agentId: "operations", text: "공개 통계 데이터 외부 공유를 허용한다." },
    { agentId: "security", text: "개인정보 원문 외부 전송을 금지한다." },
  ]);

  assert.equal(analysis.status, "none-detected");
  assert.equal(analysis.conflicts.length, 0);
});

test("negative phrases containing a positive verb are classified only as negative", () => {
  const analysis = detectExplicitClaimConflicts([
    { agentId: "security", text: "개인정보 원문 외부 전송을 허용하지 않는다." },
  ]);

  assert.equal(analysis.status, "none-detected");
  assert.equal(analysis.positiveClaimCount, 0);
  assert.equal(analysis.negativeClaimCount, 1);
});

test("a single Agent's contradictory explicit claims are still detected", () => {
  const analysis = detectExplicitClaimConflicts([
    {
      agentId: "security",
      text: "개인정보 원문 외부 전송을 허용한다. 개인정보 원문 외부 전송을 금지한다.",
    },
  ]);

  assert.equal(analysis.status, "detected");
  assert.equal(analysis.conflicts.length, 1);
  assert.equal(analysis.conflicts[0].leftAgentId, "security");
  assert.equal(analysis.conflicts[0].rightAgentId, "security");
});

test("claims without explicit allow/deny language are marked not evaluable", () => {
  const analysis = detectExplicitClaimConflicts([
    { agentId: "legal", text: "법무 검토와 책임자 승인이 필요합니다." },
  ]);

  assert.equal(analysis.status, "not-evaluable");
  assert.equal(analysis.evaluatedClaimCount, 0);
  assert.equal(analysis.conflicts.length, 0);
});
