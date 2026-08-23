import type { AgentId, Classification, KnowledgeChunk } from "./agent-registry";
import type { RequiredConcept } from "./boundary-router";

export type EvidenceMode = "sanitized" | "metadata-only";
export type EvidenceCoverageStatus = "verified" | "partial" | "unknown" | "denied";

export type EvidenceAcquisitionDecision = {
  referenceId: string;
  classification: Classification;
  mode: EvidenceMode;
  coveredConceptIds: string[];
  rationale: string;
};

export type EvidenceAcquisitionPlan = {
  strategy: "edge-policy-and-coverage";
  status: EvidenceCoverageStatus;
  requiredConceptIds: string[];
  coveredConceptIds: string[];
  missingConceptIds: string[];
  coverage: number | null;
  minimumCoverage: number;
  humanReviewRequired: boolean;
  decisions: EvidenceAcquisitionDecision[];
};

type RankedEvidence = {
  chunk: KnowledgeChunk;
  score: number;
};

const minimumCoverageByRole: Record<AgentId, number> = {
  tech: 0.7,
  data: 0.75,
  security: 0.8,
  legal: 0.8,
  policy: 0.7,
  finance: 0.7,
  procurement: 0.75,
  operations: 0.75,
};

function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

function tokens(text: string) {
  return normalize(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function conceptMatches(concept: RequiredConcept, text: string) {
  const haystack = normalize(text);
  const haystackTokens = new Set(tokens(text));
  return [concept.label, ...concept.aliases].some((alias) => {
    const normalizedAlias = normalize(alias);
    if (haystack.includes(normalizedAlias)) return true;
    const aliasTokens = tokens(alias);
    return aliasTokens.length > 0 && aliasTokens.every((token) =>
      [...haystackTokens].some((candidate) => candidate.includes(token) || token.includes(candidate)),
    );
  });
}

/**
 * 원문은 Edge 안에서만 검사한다. Core로 반환되는 것은 Core가 미리 보낸 concept ID와
 * 근거 reference ID, 적용된 공개 방식뿐이다.
 */
export function planEvidenceAtEdge(input: {
  agentId: AgentId;
  ranked: RankedEvidence[];
  requiredConcepts: RequiredConcept[];
  policyDenied?: boolean;
}): EvidenceAcquisitionPlan {
  const minimumCoverage = minimumCoverageByRole[input.agentId];
  const requiredConceptIds = input.requiredConcepts.map((concept) => concept.id);
  if (input.policyDenied) {
    return {
      strategy: "edge-policy-and-coverage",
      status: "denied",
      requiredConceptIds,
      coveredConceptIds: [],
      missingConceptIds: requiredConceptIds,
      coverage: requiredConceptIds.length ? 0 : null,
      minimumCoverage,
      humanReviewRequired: true,
      decisions: [],
    };
  }

  const decisions = input.ranked.map(({ chunk }): EvidenceAcquisitionDecision => {
    const searchable = `${chunk.title} ${chunk.section} ${chunk.text} ${chunk.tags.join(" ")}`;
    const coveredConceptIds = input.requiredConcepts
      .filter((concept) => conceptMatches(concept, searchable))
      .map((concept) => concept.id);
    return {
      referenceId: chunk.id,
      classification: chunk.classification,
      // Public sources may cross the boundary only as a DLP-sanitized preview.
      // Internal/confidential sources remain opaque references.
      mode: chunk.classification === "public" ? "sanitized" : "metadata-only",
      coveredConceptIds,
      rationale: chunk.classification === "public"
        ? "공개 근거는 DLP를 통과한 제목·발췌·출처만 Core에 반환합니다."
        : "제한 근거는 Edge에 보존하고 식별자와 등급만 반환합니다.",
    };
  });

  if (!requiredConceptIds.length) {
    return {
      strategy: "edge-policy-and-coverage",
      status: "unknown",
      requiredConceptIds: [],
      coveredConceptIds: [],
      missingConceptIds: [],
      coverage: null,
      minimumCoverage,
      humanReviewRequired: true,
      decisions,
    };
  }

  const coveredConceptIds = [...new Set(decisions.flatMap((decision) => decision.coveredConceptIds))];
  const covered = new Set(coveredConceptIds);
  const missingConceptIds = requiredConceptIds.filter((conceptId) => !covered.has(conceptId));
  const coverage = Number((coveredConceptIds.length / requiredConceptIds.length).toFixed(3));
  const verified = coverage >= minimumCoverage;
  return {
    strategy: "edge-policy-and-coverage",
    status: verified ? "verified" : "partial",
    requiredConceptIds,
    coveredConceptIds,
    missingConceptIds,
    coverage,
    minimumCoverage,
    humanReviewRequired: !verified,
    decisions,
  };
}
