import assert from "node:assert/strict";
import test from "node:test";

import {
  calculatePrivacyRiskScoreV2,
  calculatePrivacyRiskV2,
  detectSensitiveOccurrences,
} from "../lib/privacy-risk.ts";

const envelope = (mode, originalRanges) => ({
  id: "egress-1",
  recipientId: "edge-agent:security",
  channel: "edge-agent",
  leavesBoundary: true,
  disclosures: [{ sourceId: "query", mode, ...(originalRanges ? { originalRanges } : {}) }],
});

test("MNC-11 reference score values are exact and clamped", () => {
  assert.equal(calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio: 0,
    agentSelectionRatio: 0,
    originalDisclosureRatio: 0,
  }), 0);
  assert.equal(calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio: 0,
    agentSelectionRatio: 1 / 8,
    originalDisclosureRatio: 0,
  }), 4);
  assert.equal(calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio: 0.5,
    agentSelectionRatio: 2 / 8,
    originalDisclosureRatio: 0.4,
  }), 41);
  assert.equal(calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio: 1,
    agentSelectionRatio: 1,
    originalDisclosureRatio: 1,
  }), 100);
  assert.equal(calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio: 9,
    agentSelectionRatio: 2,
    originalDisclosureRatio: 4,
  }), 100);
});

test("occurrence detection counts repeated values instead of categories", () => {
  const occurrences = detectSensitiveOccurrences(
    "900101-1234567 010-1234-5678 and 010-9999-8888 user@example.com 192.168.0.7",
  );
  assert.equal(occurrences.length, 5);
  assert.deepEqual(
    occurrences.map((item) => item.kind),
    [
      "resident-registration-number",
      "mobile-phone",
      "mobile-phone",
      "email",
      "private-ip",
    ],
  );
});

test("fully masked sensitive spans do not enter the sensitive numerator", () => {
  const result = calculatePrivacyRiskV2({
    protectedSources: [{ id: "query", kind: "user-input", text: "call 010-1234-5678 tomorrow" }],
    egressEnvelopes: [envelope("masked")],
    selectedAgentIds: ["security"],
    totalAgentCount: 8,
  });
  assert.equal(result.privacyRiskVersion, "v2");
  assert.equal(result.sensitiveDetectedCount, 1);
  assert.equal(result.sensitiveTransmittedCount, 0);
  assert.equal(result.sensitiveTransmissionRatio, 0);
  assert.ok(result.originalDisclosureRatio > 0 && result.originalDisclosureRatio < 1);
});

test("partial and unmasked disclosures use exposed byte spans", () => {
  const text = "900101-1234567";
  const half = calculatePrivacyRiskV2({
    protectedSources: [{ id: "query", kind: "user-input", text }],
    egressEnvelopes: [envelope("partial", [{ start: 0, end: text.length / 2 }])],
    selectedAgentIds: ["security", "legal"],
    totalAgentCount: 8,
  });
  assert.equal(half.sensitiveTransmittedCount, 0.5);
  assert.equal(half.sensitiveTransmissionRatio, 0.5);
  assert.equal(half.originalDisclosureRatio, 0.5);

  const full = calculatePrivacyRiskV2({
    protectedSources: [{ id: "query", kind: "user-input", text }],
    egressEnvelopes: [envelope("raw")],
    selectedAgentIds: ["security"],
    totalAgentCount: 8,
  });
  assert.equal(full.sensitiveTransmissionRatio, 1);
  assert.equal(full.originalDisclosureRatio, 1);
});

test("replicated payloads and duplicate agents are deduplicated", () => {
  const base = {
    protectedSources: [{ id: "query", kind: "user-input", text: "safe 한글🙂 payload" }],
    selectedAgentIds: ["tech", "tech", "data"],
    totalAgentCount: 8,
  };
  const once = calculatePrivacyRiskV2({ ...base, egressEnvelopes: [envelope("raw")] });
  const twice = calculatePrivacyRiskV2({
    ...base,
    egressEnvelopes: [
      envelope("raw"),
      { ...envelope("raw"), id: "egress-2", recipientId: "edge-agent:data" },
    ],
  });
  assert.equal(once.selectedAgentCount, 2);
  assert.equal(twice.transmittedOriginalBytes, once.transmittedOriginalBytes);
  assert.equal(twice.originalDisclosureRatio, once.originalDisclosureRatio);
  assert.equal(twice.score, once.score);
  assert.equal(twice.recipientCount, 2);
});

test("UTF-8 bytes, zero denominators, range clamps, and output leak stay finite", () => {
  const utf8 = calculatePrivacyRiskV2({
    protectedSources: [{ id: "query", kind: "user-input", text: "한글🙂" }],
    egressEnvelopes: [envelope("partial", [{ start: -99, end: 999 }])],
    selectedAgentIds: ["tech"],
    totalAgentCount: 0,
    outputTexts: ["contact user@example.com"],
  });
  assert.equal(utf8.originalBytes, 10);
  assert.equal(utf8.transmittedOriginalBytes, 10);
  assert.equal(utf8.originalDisclosureRatio, 1);
  assert.equal(utf8.agentSelectionRatio, 1);
  assert.equal(utf8.outputLeak, true);
  assert.equal(utf8.privacyPass, false);
  assert.ok(utf8.diagnostics.some((item) => item.includes("zero denominator")));
  assert.ok(Number.isFinite(utf8.score));
  assert.ok(utf8.score >= 0 && utf8.score <= 100);

  const empty = calculatePrivacyRiskV2({
    protectedSources: [],
    egressEnvelopes: [],
    selectedAgentIds: [],
    totalAgentCount: 0,
  });
  assert.deepEqual(
    [empty.sensitiveTransmissionRatio, empty.agentSelectionRatio, empty.originalDisclosureRatio, empty.score],
    [0, 0, 0, 0],
  );
});
