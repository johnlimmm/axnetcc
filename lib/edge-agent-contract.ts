import {
  agentIds,
  agentProfiles,
  classifications,
  type AgentId,
  type Classification,
} from "./agent-registry";
import { isKnownConceptForAgent } from "./boundary-router";

export const EDGE_AGENT_CONTRACT_VERSION = "1" as const;

export type EdgeAgentPurpose = "orchestration" | "benchmark";
export type EdgeAgentStatus = "completed" | "fallback" | "insufficient-evidence" | "denied";
export type EdgePolicyOutcome = "allow" | "redact" | "deny";
export type EdgeTransport = "local" | "http";
export type EdgeExecutionRole = "primary" | "required-reviewer" | "supporting";
export type EdgeEvidenceMode = "sanitized" | "metadata-only";
export type EdgeEvidenceCoverageStatus = "verified" | "partial" | "unknown" | "denied";

export type EdgeAgentRequest = {
  version: typeof EDGE_AGENT_CONTRACT_VERSION;
  requestId: string;
  traceId: string;
  agentId: AgentId;
  purpose: EdgeAgentPurpose;
  minimalQuery: string;
  requestedMaxClassification?: Classification;
  evidenceRequirements?: {
    executionRole: EdgeExecutionRole;
    requiredConceptIds: string[];
  };
  limits: {
    topK: number;
    deadlineMs: number;
  };
};

export type PublicEvidenceReference = {
  referenceId: string;
  classification: "public";
  disclosure: "excerpt";
  title: string;
  section: string;
  excerpt: string;
  sourceUrl?: string;
  retrievalScore: number;
};

export type ReferenceOnlyEvidenceReference = {
  referenceId: string;
  classification: Classification;
  disclosure: "reference-only";
};

export type EdgeEvidenceReference = PublicEvidenceReference | ReferenceOnlyEvidenceReference;

export type EdgePolicyDecision = {
  decisionId: string;
  outcome: EdgePolicyOutcome;
  effectiveClasses: Classification[];
  highestEvidenceClassification: Classification | null;
  redactionCount: number;
  blockedCount: number;
};

export type EdgeAgentMetrics = {
  backend: "ollama" | "deterministic";
  answerSource: "local-llm" | "deterministic-fallback";
  model: string;
  fallbackReason?: string;
  evidenceCount: number;
  sourceBytesProcessed: number;
  egressBytes: number;
  latencyMs: number;
  ttftMs: number | null;
  tpotMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  corpusChunks: number;
};

export type EdgeBoundaryReport = {
  transport: EdgeTransport;
  rawCorpusTransferred: false;
  returnedBytes: number;
  evidencePayloadBytes: number;
  restrictedEvidenceCount: number;
};

export type EdgeAuditReference = {
  eventId: string;
  recordedAt: string;
  policyVersion: string;
};

export type EdgeEvidencePlan = {
  strategy: "edge-policy-and-coverage";
  status: EdgeEvidenceCoverageStatus;
  requiredConceptIds: string[];
  coveredConceptIds: string[];
  missingConceptIds: string[];
  coverage: number | null;
  minimumCoverage: number;
  humanReviewRequired: boolean;
  decisions: Array<{
    referenceId: string;
    classification: Classification;
    mode: EdgeEvidenceMode;
    coveredConceptIds: string[];
    rationale: string;
  }>;
};

export type EdgeAgentResponse = {
  version: typeof EDGE_AGENT_CONTRACT_VERSION;
  requestId: string;
  agentId: AgentId;
  status: EdgeAgentStatus;
  answer: {
    text: string;
    classification: Classification;
    citations: string[];
  };
  evidence: EdgeEvidenceReference[];
  evidencePlan?: EdgeEvidencePlan;
  policy: EdgePolicyDecision;
  metrics: EdgeAgentMetrics;
  boundary: EdgeBoundaryReport;
  audit: EdgeAuditReference;
};

export class EdgeContractValidationError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "EdgeContractValidationError";
  }
}

type JsonRecord = Record<string, unknown>;

const agentIdSet = new Set<string>(agentIds);
const classificationSet = new Set<string>(classifications);
const classificationRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

function asRecord(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EdgeContractValidationError(path, "객체여야 합니다.");
  }
  return value as JsonRecord;
}

function asString(value: unknown, path: string, maxLength = 4_000): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EdgeContractValidationError(path, "비어 있지 않은 문자열이어야 합니다.");
  }
  if (value.length > maxLength) {
    throw new EdgeContractValidationError(path, `${maxLength}자를 초과할 수 없습니다.`);
  }
  return value;
}

function asLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    throw new EdgeContractValidationError(path, `'${expected}'이어야 합니다.`);
  }
  return expected;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new EdgeContractValidationError(path, `허용값은 ${allowed.join(", ")}입니다.`);
  }
  return value as T;
}

function asInteger(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new EdgeContractValidationError(path, `${minimum} 이상 ${maximum} 이하의 정수여야 합니다.`);
  }
  return value as number;
}

function asFiniteNumber(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new EdgeContractValidationError(path, `${minimum} 이상의 유한한 숫자여야 합니다.`);
  }
  return value;
}

function asNullableFiniteNumber(value: unknown, path: string): number | null {
  return value === null ? null : asFiniteNumber(value, path);
}

function asRatio(value: unknown, path: string): number {
  const parsed = asFiniteNumber(value, path);
  if (parsed > 1) throw new EdgeContractValidationError(path, "0 이상 1 이하의 숫자여야 합니다.");
  return parsed;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new EdgeContractValidationError(path, "boolean이어야 합니다.");
  return value;
}

function asAgentId(value: unknown, path: string): AgentId {
  if (typeof value !== "string" || !agentIdSet.has(value)) {
    throw new EdgeContractValidationError(path, "등록된 Agent ID가 아닙니다.");
  }
  return value as AgentId;
}

function asClassification(value: unknown, path: string): Classification {
  if (typeof value !== "string" || !classificationSet.has(value)) {
    throw new EdgeContractValidationError(path, "지원되는 classification이 아닙니다.");
  }
  return value as Classification;
}

function asStringArray(value: unknown, path: string, maximumItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new EdgeContractValidationError(path, `${maximumItems}개 이하의 배열이어야 합니다.`);
  }
  return value.map((item, index) => asString(item, `${path}[${index}]`, 256));
}

function asClassificationArray(value: unknown, path: string): Classification[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > classifications.length) {
    throw new EdgeContractValidationError(path, "classification 배열이어야 합니다.");
  }
  const parsed = value.map((item, index) => asClassification(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new EdgeContractValidationError(path, "중복 classification을 포함할 수 없습니다.");
  }
  return parsed;
}

function asHttpUrl(value: unknown, path: string): string {
  const url = asString(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EdgeContractValidationError(path, "유효한 URL이어야 합니다.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EdgeContractValidationError(path, "HTTP(S) URL만 허용됩니다.");
  }
  return url;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function validateEdgeAgentRequest(input: unknown): EdgeAgentRequest {
  const request = asRecord(input, "request");
  const limits = asRecord(request.limits, "request.limits");
  const agentId = asAgentId(request.agentId, "request.agentId");
  const evidenceRequirementsInput = request.evidenceRequirements === undefined
    ? undefined
    : asRecord(request.evidenceRequirements, "request.evidenceRequirements");
  const requiredConceptIds = evidenceRequirementsInput === undefined
    ? undefined
    : (() => {
        const parsed = asStringArray(
          evidenceRequirementsInput.requiredConceptIds,
          "request.evidenceRequirements.requiredConceptIds",
          32,
        );
        if (new Set(parsed).size !== parsed.length) {
          throw new EdgeContractValidationError(
            "request.evidenceRequirements.requiredConceptIds",
            "중복 concept ID를 포함할 수 없습니다.",
          );
        }
        if (parsed.some((conceptId) => !isKnownConceptForAgent(conceptId, agentId))) {
          throw new EdgeContractValidationError(
            "request.evidenceRequirements.requiredConceptIds",
            `${agentId} Agent에 등록된 concept ID만 사용할 수 있습니다.`,
          );
        }
        return parsed;
      })();
  const requestedMaxClassification = request.requestedMaxClassification === undefined
    ? undefined
    : asClassification(request.requestedMaxClassification, "request.requestedMaxClassification");

  return {
    version: asLiteral(request.version, EDGE_AGENT_CONTRACT_VERSION, "request.version"),
    requestId: asString(request.requestId, "request.requestId", 128),
    traceId: asString(request.traceId, "request.traceId", 128),
    agentId,
    purpose: asEnum(request.purpose, ["orchestration", "benchmark"] as const, "request.purpose"),
    minimalQuery: asString(request.minimalQuery, "request.minimalQuery", 4_000),
    ...(requestedMaxClassification ? { requestedMaxClassification } : {}),
    ...(evidenceRequirementsInput && requiredConceptIds ? {
      evidenceRequirements: {
        executionRole: asEnum(
          evidenceRequirementsInput.executionRole,
          ["primary", "required-reviewer", "supporting"] as const,
          "request.evidenceRequirements.executionRole",
        ),
        requiredConceptIds,
      },
    } : {}),
    limits: {
      topK: asInteger(limits.topK, "request.limits.topK", 1, 10),
      deadlineMs: asInteger(limits.deadlineMs, "request.limits.deadlineMs", 100, 120_000),
    },
  };
}

function validateEvidenceReference(input: unknown, path: string): EdgeEvidenceReference {
  const evidence = asRecord(input, path);
  const classification = asClassification(evidence.classification, `${path}.classification`);
  const referenceId = asString(evidence.referenceId, `${path}.referenceId`, 256);

  if (classification === "public" && evidence.disclosure === "excerpt") {
    return {
      referenceId,
      classification,
      disclosure: asLiteral(evidence.disclosure, "excerpt", `${path}.disclosure`),
      title: asString(evidence.title, `${path}.title`, 512),
      section: asString(evidence.section, `${path}.section`, 512),
      excerpt: asString(evidence.excerpt, `${path}.excerpt`, 500),
      ...(evidence.sourceUrl === undefined ? {} : { sourceUrl: asHttpUrl(evidence.sourceUrl, `${path}.sourceUrl`) }),
      retrievalScore: asFiniteNumber(evidence.retrievalScore, `${path}.retrievalScore`),
    };
  }

  for (const forbidden of ["title", "section", "excerpt", "sourceUrl", "retrievalScore", "text", "rawText"]) {
    if (hasOwn(evidence, forbidden)) {
      throw new EdgeContractValidationError(
        `${path}.${forbidden}`,
        `${classification} evidence에는 원문 또는 식별 metadata를 포함할 수 없습니다.`,
      );
    }
  }
  return {
    referenceId,
    classification,
    disclosure: asLiteral(evidence.disclosure, "reference-only", `${path}.disclosure`),
  };
}

function highestClassification(evidence: EdgeEvidenceReference[]): Classification | null {
  return evidence.reduce<Classification | null>((highest, item) => {
    if (!highest || classificationRank[item.classification] > classificationRank[highest]) {
      return item.classification;
    }
    return highest;
  }, null);
}

function validateEvidencePlan(
  input: unknown,
  evidence: EdgeEvidenceReference[],
): EdgeEvidencePlan {
  const plan = asRecord(input, "response.evidencePlan");
  const requiredConceptIds = asStringArray(
    plan.requiredConceptIds,
    "response.evidencePlan.requiredConceptIds",
    32,
  );
  const coveredConceptIds = asStringArray(
    plan.coveredConceptIds,
    "response.evidencePlan.coveredConceptIds",
    32,
  );
  const missingConceptIds = asStringArray(
    plan.missingConceptIds,
    "response.evidencePlan.missingConceptIds",
    32,
  );
  for (const [path, values] of [
    ["requiredConceptIds", requiredConceptIds],
    ["coveredConceptIds", coveredConceptIds],
    ["missingConceptIds", missingConceptIds],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new EdgeContractValidationError(`response.evidencePlan.${path}`, "중복 값을 포함할 수 없습니다.");
    }
  }
  const required = new Set(requiredConceptIds);
  if ([...coveredConceptIds, ...missingConceptIds].some((id) => !required.has(id))) {
    throw new EdgeContractValidationError(
      "response.evidencePlan",
      "covered/missing concept는 requiredConceptIds에 포함되어야 합니다.",
    );
  }
  if (coveredConceptIds.some((id) => missingConceptIds.includes(id))) {
    throw new EdgeContractValidationError("response.evidencePlan", "concept는 covered와 missing에 동시에 포함될 수 없습니다.");
  }
  const status = asEnum(
    plan.status,
    ["verified", "partial", "unknown", "denied"] as const,
    "response.evidencePlan.status",
  );
  const minimumCoverage = asRatio(plan.minimumCoverage, "response.evidencePlan.minimumCoverage");
  const coverage = plan.coverage === null
    ? null
    : asRatio(plan.coverage, "response.evidencePlan.coverage");
  const humanReviewRequired = asBoolean(
    plan.humanReviewRequired,
    "response.evidencePlan.humanReviewRequired",
  );
  if (!requiredConceptIds.length && (coverage !== null || status !== "unknown" || !humanReviewRequired)) {
    throw new EdgeContractValidationError(
      "response.evidencePlan",
      "필수 concept가 비어 있으면 coverage는 unknown이며 사람 검토가 필요합니다.",
    );
  }
  if (requiredConceptIds.length && coverage === null) {
    throw new EdgeContractValidationError("response.evidencePlan.coverage", "필수 concept가 있으면 숫자 coverage가 필요합니다.");
  }
  if (!Array.isArray(plan.decisions) || plan.decisions.length > 10) {
    throw new EdgeContractValidationError("response.evidencePlan.decisions", "10개 이하의 배열이어야 합니다.");
  }
  const evidenceById = new Map(evidence.map((item) => [item.referenceId, item]));
  const decisions = plan.decisions.map((item, index) => {
    const path = `response.evidencePlan.decisions[${index}]`;
    const decision = asRecord(item, path);
    const referenceId = asString(decision.referenceId, `${path}.referenceId`, 256);
    const classification = asClassification(decision.classification, `${path}.classification`);
    const returnedEvidence = evidenceById.get(referenceId);
    if (!returnedEvidence || returnedEvidence.classification !== classification) {
      throw new EdgeContractValidationError(path, "반환된 evidence reference와 일치해야 합니다.");
    }
    const mode = asEnum(decision.mode, ["sanitized", "metadata-only"] as const, `${path}.mode`);
    const expectedMode = returnedEvidence.disclosure === "reference-only"
      ? "metadata-only"
      : "sanitized";
    if (mode !== expectedMode) {
      throw new EdgeContractValidationError(`${path}.mode`, "classification의 Edge 공개 정책과 일치하지 않습니다.");
    }
    const decisionCovered = asStringArray(decision.coveredConceptIds, `${path}.coveredConceptIds`, 32);
    if (decisionCovered.some((id) => !required.has(id))) {
      throw new EdgeContractValidationError(`${path}.coveredConceptIds`, "required concept만 참조할 수 있습니다.");
    }
    return {
      referenceId,
      classification,
      mode,
      coveredConceptIds: decisionCovered,
      rationale: asString(decision.rationale, `${path}.rationale`, 512),
    };
  });
  return {
    strategy: asLiteral(plan.strategy, "edge-policy-and-coverage", "response.evidencePlan.strategy"),
    status,
    requiredConceptIds,
    coveredConceptIds,
    missingConceptIds,
    coverage,
    minimumCoverage,
    humanReviewRequired,
    decisions,
  };
}

export function validateEdgeAgentResponse(input: unknown): EdgeAgentResponse {
  const response = asRecord(input, "response");
  const responseAgentId = asAgentId(response.agentId, "response.agentId");
  const answerInput = asRecord(response.answer, "response.answer");
  const policyInput = asRecord(response.policy, "response.policy");
  const metricsInput = asRecord(response.metrics, "response.metrics");
  const boundaryInput = asRecord(response.boundary, "response.boundary");
  const auditInput = asRecord(response.audit, "response.audit");

  if (!Array.isArray(response.evidence) || response.evidence.length > 10) {
    throw new EdgeContractValidationError("response.evidence", "10개 이하의 배열이어야 합니다.");
  }
  const evidence = response.evidence.map((item, index) =>
    validateEvidenceReference(item, `response.evidence[${index}]`),
  );
  const evidencePlan = response.evidencePlan === undefined
    ? undefined
    : validateEvidencePlan(response.evidencePlan, evidence);
  const effectiveClasses = asClassificationArray(
    policyInput.effectiveClasses,
    "response.policy.effectiveClasses",
  );
  const agentAllowedClasses: readonly Classification[] =
    agentProfiles[responseAgentId].allowedClasses;
  for (const classification of effectiveClasses) {
    if (!agentAllowedClasses.includes(classification)) {
      throw new EdgeContractValidationError(
        "response.policy.effectiveClasses",
        `${responseAgentId} Agent cannot return ${classification} evidence`,
      );
    }
  }
  for (const item of evidence) {
    if (!effectiveClasses.includes(item.classification)) {
      throw new EdgeContractValidationError(
        "response.evidence",
        `${item.classification} evidence가 effectiveClasses 밖에 있습니다.`,
      );
    }
  }

  const reportedHighest = policyInput.highestEvidenceClassification === null
    ? null
    : asClassification(
        policyInput.highestEvidenceClassification,
        "response.policy.highestEvidenceClassification",
      );
  const actualHighest = highestClassification(evidence);
  if (reportedHighest !== actualHighest) {
    throw new EdgeContractValidationError(
      "response.policy.highestEvidenceClassification",
      "반환 evidence의 최고 classification과 일치해야 합니다.",
    );
  }

  const answerClassification = asClassification(
    answerInput.classification,
    "response.answer.classification",
  );
  if (!effectiveClasses.includes(answerClassification)) {
    throw new EdgeContractValidationError(
      "response.answer.classification",
      "answer classification must be included in effectiveClasses",
    );
  }
  if (actualHighest && classificationRank[answerClassification] < classificationRank[actualHighest]) {
    throw new EdgeContractValidationError(
      "response.answer.classification",
      "근거보다 낮은 등급으로 자동 하향할 수 없습니다.",
    );
  }

  const citations = asStringArray(answerInput.citations, "response.answer.citations", 20);
  const referenceIds = new Set(evidence.map((item) => item.referenceId));
  for (const citation of citations) {
    if (!referenceIds.has(citation)) {
      throw new EdgeContractValidationError(
        "response.answer.citations",
        "citation must reference returned evidence",
      );
    }
  }

  const evidenceCount = asInteger(
    metricsInput.evidenceCount,
    "response.metrics.evidenceCount",
    0,
    10,
  );
  if (evidenceCount !== evidence.length) {
    throw new EdgeContractValidationError(
      "response.metrics.evidenceCount",
      "반환 evidence 개수와 일치해야 합니다.",
    );
  }
  const restrictedEvidenceCount = asInteger(
    boundaryInput.restrictedEvidenceCount,
    "response.boundary.restrictedEvidenceCount",
    0,
    10,
  );
  const actualRestrictedCount = evidence.filter((item) => item.classification !== "public").length;
  if (restrictedEvidenceCount !== actualRestrictedCount) {
    throw new EdgeContractValidationError(
      "response.boundary.restrictedEvidenceCount",
      "restricted evidence 개수와 일치해야 합니다.",
    );
  }
  if (boundaryInput.rawCorpusTransferred !== false) {
    throw new EdgeContractValidationError(
      "response.boundary.rawCorpusTransferred",
      "안전한 Edge 계약에서는 반드시 false여야 합니다.",
    );
  }

  const recordedAt = asString(auditInput.recordedAt, "response.audit.recordedAt", 64);
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new EdgeContractValidationError("response.audit.recordedAt", "유효한 날짜여야 합니다.");
  }

  return {
    version: asLiteral(response.version, EDGE_AGENT_CONTRACT_VERSION, "response.version"),
    requestId: asString(response.requestId, "response.requestId", 128),
    agentId: responseAgentId,
    status: asEnum(
      response.status,
      ["completed", "fallback", "insufficient-evidence", "denied"] as const,
      "response.status",
    ),
    answer: {
      text: asString(answerInput.text, "response.answer.text", 4_000),
      classification: answerClassification,
      citations,
    },
    evidence,
    ...(evidencePlan ? { evidencePlan } : {}),
    policy: {
      decisionId: asString(policyInput.decisionId, "response.policy.decisionId", 256),
      outcome: asEnum(policyInput.outcome, ["allow", "redact", "deny"] as const, "response.policy.outcome"),
      effectiveClasses,
      highestEvidenceClassification: reportedHighest,
      redactionCount: asInteger(policyInput.redactionCount, "response.policy.redactionCount"),
      blockedCount: asInteger(policyInput.blockedCount, "response.policy.blockedCount"),
    },
    metrics: {
      backend: asEnum(metricsInput.backend, ["ollama", "deterministic"] as const, "response.metrics.backend"),
      answerSource: asEnum(
        metricsInput.answerSource,
        ["local-llm", "deterministic-fallback"] as const,
        "response.metrics.answerSource",
      ),
      model: asString(metricsInput.model, "response.metrics.model", 256),
      ...(metricsInput.fallbackReason === undefined
        ? {}
        : { fallbackReason: asString(metricsInput.fallbackReason, "response.metrics.fallbackReason", 512) }),
      evidenceCount,
      sourceBytesProcessed: asInteger(metricsInput.sourceBytesProcessed, "response.metrics.sourceBytesProcessed"),
      egressBytes: asInteger(metricsInput.egressBytes, "response.metrics.egressBytes"),
      latencyMs: asInteger(metricsInput.latencyMs, "response.metrics.latencyMs"),
      ttftMs: asNullableFiniteNumber(metricsInput.ttftMs, "response.metrics.ttftMs"),
      tpotMs: asNullableFiniteNumber(metricsInput.tpotMs, "response.metrics.tpotMs"),
      promptTokens: asNullableFiniteNumber(metricsInput.promptTokens, "response.metrics.promptTokens"),
      completionTokens: asNullableFiniteNumber(metricsInput.completionTokens, "response.metrics.completionTokens"),
      corpusChunks: asInteger(metricsInput.corpusChunks, "response.metrics.corpusChunks"),
    },
    boundary: {
      transport: asEnum(boundaryInput.transport, ["local", "http"] as const, "response.boundary.transport"),
      rawCorpusTransferred: false,
      returnedBytes: asInteger(boundaryInput.returnedBytes, "response.boundary.returnedBytes"),
      evidencePayloadBytes: asInteger(boundaryInput.evidencePayloadBytes, "response.boundary.evidencePayloadBytes"),
      restrictedEvidenceCount,
    },
    audit: {
      eventId: asString(auditInput.eventId, "response.audit.eventId", 256),
      recordedAt,
      policyVersion: asString(auditInput.policyVersion, "response.audit.policyVersion", 128),
    },
  };
}

export function isEdgeAgentRequest(input: unknown): input is EdgeAgentRequest {
  try {
    validateEdgeAgentRequest(input);
    return true;
  } catch {
    return false;
  }
}

export function isEdgeAgentResponse(input: unknown): input is EdgeAgentResponse {
  try {
    validateEdgeAgentResponse(input);
    return true;
  } catch {
    return false;
  }
}
