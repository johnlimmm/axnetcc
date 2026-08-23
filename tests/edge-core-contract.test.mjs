import assert from "node:assert/strict";
import test from "node:test";

import {
  CoreEdgeContractValidationError,
  projectEdgeAgentResponseForCore,
  validateCoreEdgeAgentResponse,
} from "../lib/edge-core-contract.ts";

function internalEdgeResponse() {
  return {
    version: "1",
    requestId: "EDGE-MNC6-1",
    agentId: "security",
    status: "completed",
    answer: {
      text: "Edge에서 정책 검토를 완료했습니다. [PUB-1] [INT-1]",
      classification: "internal",
      citations: ["PUB-1", "INT-1"],
    },
    evidence: [
      {
        referenceId: "PUB-1",
        classification: "public",
        disclosure: "excerpt",
        title: "PUBLIC-TITLE-MUST-STAY-AT-EDGE",
        section: "PUBLIC-SECTION-MUST-STAY-AT-EDGE",
        excerpt: "CORPUS-RAW-PARAGRAPH-MUST-STAY-AT-EDGE",
        sourceUrl: "https://edge.example/private-source-location",
        retrievalScore: 91.2,
      },
      {
        referenceId: "INT-1",
        classification: "internal",
        disclosure: "reference-only",
      },
    ],
    evidencePlan: {
      strategy: "edge-policy-and-coverage",
      status: "verified",
      requiredConceptIds: ["security.access-control"],
      coveredConceptIds: ["security.access-control"],
      missingConceptIds: [],
      coverage: 1,
      minimumCoverage: 0.8,
      humanReviewRequired: false,
      decisions: [
        {
          referenceId: "PUB-1",
          classification: "public",
          mode: "sanitized",
          coveredConceptIds: ["security.access-control"],
          rationale: "RAW-RATIONALE-MUST-STAY-AT-EDGE",
        },
        {
          referenceId: "INT-1",
          classification: "internal",
          mode: "metadata-only",
          coveredConceptIds: ["security.access-control"],
          rationale: "INTERNAL-RATIONALE-MUST-STAY-AT-EDGE",
        },
      ],
    },
    policy: {
      decisionId: "POL-MNC6-1",
      outcome: "redact",
      effectiveClasses: ["public", "internal", "confidential"],
      highestEvidenceClassification: "internal",
      redactionCount: 1,
      blockedCount: 0,
    },
    metrics: {
      backend: "deterministic",
      answerSource: "deterministic-fallback",
      model: "edge-test-model",
      fallbackReason: "FREE-FORM-ERROR-MUST-STAY-AT-EDGE",
      evidenceCount: 2,
      sourceBytesProcessed: 8_192,
      egressBytes: 0,
      latencyMs: 12,
      ttftMs: null,
      tpotMs: null,
      promptTokens: null,
      completionTokens: null,
      corpusChunks: 20,
    },
    boundary: {
      transport: "local",
      rawCorpusTransferred: false,
      returnedBytes: 0,
      evidencePayloadBytes: 0,
      restrictedEvidenceCount: 1,
    },
    audit: {
      eventId: "AUD-MNC6-1",
      recordedAt: "2026-08-07T00:00:00.000Z",
      policyVersion: "edge-rag-v1",
    },
    minimalQuery: "900101-1234567 010-1234-5678 QUERY-MUST-STAY-AT-EDGE",
    rawCorpus: "EDGE-CORPUS-OBJECT-MUST-STAY-AT-EDGE",
  };
}

test("projects public previews while restricted Edge state remains reference-only", () => {
  const internal = internalEdgeResponse();
  const projected = projectEdgeAgentResponseForCore(internal, "http");
  const parsed = validateCoreEdgeAgentResponse(JSON.parse(JSON.stringify(projected)));

  assert.equal(internal.evidence[0].title, "PUBLIC-TITLE-MUST-STAY-AT-EDGE");
  assert.deepEqual(parsed.evidenceRefs, [
    {
      referenceId: "PUB-1",
      classification: "public",
      disclosure: "sanitized-preview",
      title: "PUBLIC-TITLE-MUST-STAY-AT-EDGE",
      section: "PUBLIC-SECTION-MUST-STAY-AT-EDGE",
      excerpt: "CORPUS-RAW-PARAGRAPH-MUST-STAY-AT-EDGE",
      sourceUrl: "https://edge.example/private-source-location",
      retrievalScore: 91.2,
    },
    { referenceId: "INT-1", classification: "internal", disclosure: "reference-only" },
  ]);
  assert.deepEqual(parsed.summary.evidenceIds, ["PUB-1", "INT-1"]);
  assert.equal(parsed.evidencePlan.decisions[0].appliedMode, "sanitized");
  assert.equal(parsed.evidencePlan.decisions[1].appliedMode, "metadata-only");
  assert.equal(parsed.evidencePlan.decisions[0].plannedMode, "sanitized");
  assert.equal(parsed.evidencePlan.decisions[0].plannedMode, parsed.evidencePlan.decisions[0].appliedMode);
  assert.equal(parsed.evidencePlan.decisions[1].plannedMode, parsed.evidencePlan.decisions[1].appliedMode);
  assert.ok(parsed.evidencePlan.decisions.every((decision) => decision.egressBytes > 0));
  assert.equal(parsed.evidencePlan.decisions[0].mode, "sanitized");
  assert.equal(parsed.evidencePlan.decisions[1].mode, "metadata-only");

  const serialized = JSON.stringify(parsed);
  for (const forbidden of [
    "RAW-RATIONALE-MUST-STAY-AT-EDGE",
    "INTERNAL-RATIONALE-MUST-STAY-AT-EDGE",
    "FREE-FORM-ERROR-MUST-STAY-AT-EDGE",
    "QUERY-MUST-STAY-AT-EDGE",
    "EDGE-CORPUS-OBJECT-MUST-STAY-AT-EDGE",
    "900101-1234567",
    "010-1234-5678",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} crossed the boundary`);
  }
  assert.equal(parsed.metrics.egressBytes, new TextEncoder().encode(serialized).length);
  assert.equal(parsed.boundary.returnedBytes, parsed.metrics.egressBytes);
  assert.equal(parsed.audit.policyDecisionId, parsed.policy.decisionId);
  assert.equal(parsed.metrics.fallbackReasonCode, "unknown");
});

test("rejects unknown keys at the top level and restricted references", () => {
  const valid = projectEdgeAgentResponseForCore(internalEdgeResponse(), "http");
  const topLevel = structuredClone(valid);
  topLevel.query = "must not be accepted";
  assert.throws(
    () => validateCoreEdgeAgentResponse(topLevel),
    (error) => error instanceof CoreEdgeContractValidationError && /response\.query: unknown key/.test(error.message),
  );

  const nested = structuredClone(valid);
  nested.evidenceRefs[1].title = "internal title must fail";
  assert.throws(
    () => validateCoreEdgeAgentResponse(nested),
    (error) => error instanceof CoreEdgeContractValidationError && /\.title: unknown key/.test(error.message),
  );
});

test("rejects unsanitized personal identifiers in public previews", () => {
  const valid = projectEdgeAgentResponseForCore(internalEdgeResponse(), "http");
  const unsafe = structuredClone(valid);
  unsafe.evidenceRefs[0].excerpt = "담당자 010-1234-5678";
  assert.throws(
    () => validateCoreEdgeAgentResponse(unsafe),
    (error) => error instanceof CoreEdgeContractValidationError && /DLP-sanitized/.test(error.message),
  );
});

test("fails closed when an Agent or policy classification is inconsistent", () => {
  const valid = projectEdgeAgentResponseForCore(internalEdgeResponse(), "http");
  const violation = structuredClone(valid);
  violation.agentId = "legal";
  assert.throws(
    () => validateCoreEdgeAgentResponse(violation),
    (error) => error instanceof CoreEdgeContractValidationError && /classification ceiling exceeded/.test(error.message),
  );

  const unlisted = structuredClone(valid);
  unlisted.policy.effectiveClasses = ["public"];
  assert.throws(
    () => validateCoreEdgeAgentResponse(unlisted),
    (error) => error instanceof CoreEdgeContractValidationError && /outside effectiveClasses/.test(error.message),
  );
});
