import type { AgentId, Classification } from "./agent-registry";
import { sanitizeSensitiveText } from "./data-loss-prevention.ts";
import type {
  EdgeAgentResponse,
  EdgeAgentStatus,
  EdgeEvidenceCoverageStatus,
  EdgeEvidenceMode,
  EdgePolicyOutcome,
  EdgeTransport,
} from "./edge-agent-contract";

/**
 * Physical Edge -> Core boundary contract.
 *
 * The richer EdgeAgentResponse remains inside the Edge process. This DTO only
 * carries a derived summary, DLP-sanitized public previews or opaque restricted
 * references, numeric metrics, and policy/audit metadata. Query, prompt,
 * internal/confidential text, and corpus objects have no representation here.
 */
export const EDGE_CORE_CONTRACT_VERSION = "1" as const;

export type CorePublicEvidenceReference = {
  referenceId: string;
  classification: "public";
  disclosure: "sanitized-preview";
  title: string;
  section: string;
  excerpt: string;
  excerptMode?: "public-passage";
  publishedAt?: string;
  sourceSha256?: string;
  licenseReview?: string;
  sourceUrl?: string;
  retrievalScore: number;
};

export type CoreRestrictedEvidenceReference = {
  referenceId: string;
  classification: Classification;
  disclosure: "reference-only";
};

export type CoreEvidenceReference = CorePublicEvidenceReference | CoreRestrictedEvidenceReference;

export type CoreEvidenceDecision = {
  referenceId: string;
  classification: Classification;
  plannedMode: EdgeEvidenceMode;
  appliedMode: EdgeEvidenceMode;
  /** Temporary compatibility alias for the applied transfer mode. */
  mode?: EdgeEvidenceMode;
  egressBytes: number;
  coveredConceptIds: string[];
};

export type CoreEvidencePlan = {
  strategy: "edge-policy-and-coverage";
  status: EdgeEvidenceCoverageStatus;
  requiredConceptIds: string[];
  coveredConceptIds: string[];
  missingConceptIds: string[];
  coverage: number | null;
  minimumCoverage: number;
  humanReviewRequired: boolean;
  decisions: CoreEvidenceDecision[];
};

export type CoreFallbackReasonCode =
  | "not-configured"
  | "empty-response"
  | "timeout"
  | "http-error"
  | "connection-error"
  | "edge-status"
  | "unknown";

export type CoreEdgeAgentResponse = {
  version: typeof EDGE_CORE_CONTRACT_VERSION;
  requestId: string;
  agentId: AgentId;
  status: EdgeAgentStatus;
  summary: {
    text: string;
    classification: Classification;
    evidenceIds: string[];
  };
  evidenceRefs: CoreEvidenceReference[];
  evidencePlan?: CoreEvidencePlan;
  policy: {
    decisionId: string;
    outcome: EdgePolicyOutcome;
    effectiveClasses: Classification[];
    highestEvidenceClassification: Classification | null;
    redactionCount: number;
    blockedCount: number;
  };
  metrics: {
    backend: "ollama" | "deterministic";
    answerSource: "local-llm" | "deterministic-fallback";
    model: string;
    fallbackReasonCode?: CoreFallbackReasonCode;
    evidenceCount: number;
    sourceBytesProcessed: number;
    egressBytes: number;
    latencyMs: number;
    ttftMs: number | null;
    tpotMs: number | null;
    tokensPerSecond?: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    corpusChunks: number;
  };
  boundary: {
    transport: EdgeTransport;
    rawCorpusTransferred: false;
    returnedBytes: number;
    evidencePayloadBytes: number;
    restrictedEvidenceCount: number;
  };
  audit: {
    eventId: string;
    recordedAt: string;
    policyVersion: string;
    policyDecisionId: string;
  };
};

export class CoreEdgeContractValidationError extends TypeError {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CoreEdgeContractValidationError";
  }
}

type JsonRecord = Record<string, unknown>;

const agentIds = [
  "tech",
  "data",
  "security",
  "legal",
  "policy",
  "finance",
  "procurement",
  "operations",
] as const satisfies readonly AgentId[];
const classifications = ["public", "internal", "confidential"] as const;
const agentIdSet = new Set<string>(agentIds);
const classificationSet = new Set<string>(classifications);
const allowedClassesByAgent: Record<AgentId, readonly Classification[]> = {
  tech: ["public", "internal"],
  data: ["public", "internal"],
  security: ["public", "internal", "confidential"],
  legal: ["public", "internal"],
  policy: ["public", "internal"],
  finance: ["public", "internal"],
  procurement: ["public", "internal"],
  operations: ["public", "internal"],
};
const classificationRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};
const encoder = new TextEncoder();

function asRecord(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreEdgeContractValidationError(path, "must be an object");
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, allowed: readonly string[], path: string) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new CoreEdgeContractValidationError(`${path}.${unknown}`, "unknown key");
}

function asString(value: unknown, path: string, maximum = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new CoreEdgeContractValidationError(path, `must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CoreEdgeContractValidationError(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function asInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new CoreEdgeContractValidationError(path, `must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function asNumber(value: unknown, path: string, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new CoreEdgeContractValidationError(path, `must be a finite number between 0 and ${maximum}`);
  }
  return value;
}

function asNullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CoreEdgeContractValidationError(path, "must be boolean");
  return value;
}

function asHttpUrl(value: unknown, path: string): string {
  const url = asString(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CoreEdgeContractValidationError(path, "must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CoreEdgeContractValidationError(path, "must use HTTP(S)");
  }
  if (sanitizeSensitiveText(url).filteredFields.length) {
    throw new CoreEdgeContractValidationError(path, "must not contain sensitive identifiers");
  }
  return url;
}

function asDlpSafeString(value: unknown, path: string, maximum: number) {
  const text = asString(value, path, maximum);
  if (sanitizeSensitiveText(text).filteredFields.length) {
    throw new CoreEdgeContractValidationError(path, "must be DLP-sanitized");
  }
  return text;
}

function asAgentId(value: unknown, path: string): AgentId {
  if (typeof value !== "string" || !agentIdSet.has(value)) {
    throw new CoreEdgeContractValidationError(path, "unknown Agent identifier");
  }
  return value as AgentId;
}

function asClassification(value: unknown, path: string): Classification {
  if (typeof value !== "string" || !classificationSet.has(value)) {
    throw new CoreEdgeContractValidationError(path, "unknown classification");
  }
  return value as Classification;
}

function asStringArray(value: unknown, path: string, maximumItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new CoreEdgeContractValidationError(path, `must be an array of at most ${maximumItems} items`);
  }
  const parsed = value.map((item, index) => asString(item, `${path}[${index}]`, 256));
  if (new Set(parsed).size !== parsed.length) {
    throw new CoreEdgeContractValidationError(path, "must not contain duplicates");
  }
  return parsed;
}

function asClassificationArray(value: unknown, path: string): Classification[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > classifications.length) {
    throw new CoreEdgeContractValidationError(path, "must be a non-empty classification array");
  }
  const parsed = value.map((item, index) => asClassification(item, `${path}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new CoreEdgeContractValidationError(path, "must not contain duplicates");
  }
  return parsed;
}

function highestClassification(evidence: CoreEvidenceReference[]): Classification | null {
  return evidence.reduce<Classification | null>((highest, item) => {
    return !highest || classificationRank[item.classification] > classificationRank[highest]
      ? item.classification
      : highest;
  }, null);
}

function validateEvidencePlan(input: unknown, evidenceRefs: CoreEvidenceReference[]): CoreEvidencePlan {
  const plan = asRecord(input, "response.evidencePlan");
  exactKeys(plan, [
    "strategy",
    "status",
    "requiredConceptIds",
    "coveredConceptIds",
    "missingConceptIds",
    "coverage",
    "minimumCoverage",
    "humanReviewRequired",
    "decisions",
  ], "response.evidencePlan");
  const requiredConceptIds = asStringArray(plan.requiredConceptIds, "response.evidencePlan.requiredConceptIds", 32);
  const coveredConceptIds = asStringArray(plan.coveredConceptIds, "response.evidencePlan.coveredConceptIds", 32);
  const missingConceptIds = asStringArray(plan.missingConceptIds, "response.evidencePlan.missingConceptIds", 32);
  const required = new Set(requiredConceptIds);
  if ([...coveredConceptIds, ...missingConceptIds].some((id) => !required.has(id)) ||
      coveredConceptIds.some((id) => missingConceptIds.includes(id))) {
    throw new CoreEdgeContractValidationError("response.evidencePlan", "coverage concepts violate the required set");
  }
  const coverage = plan.coverage === null
    ? null
    : asNumber(plan.coverage, "response.evidencePlan.coverage", 1);
  const minimumCoverage = asNumber(plan.minimumCoverage, "response.evidencePlan.minimumCoverage", 1);
  if (!Array.isArray(plan.decisions) || plan.decisions.length > 10) {
    throw new CoreEdgeContractValidationError("response.evidencePlan.decisions", "must contain at most 10 decisions");
  }
  const references = new Map(evidenceRefs.map((item) => [item.referenceId, item]));
  const decisions = plan.decisions.map((inputDecision, index): CoreEvidenceDecision => {
    const path = `response.evidencePlan.decisions[${index}]`;
    const decision = asRecord(inputDecision, path);
    exactKeys(decision, [
      "referenceId",
      "classification",
      "plannedMode",
      "appliedMode",
      "mode",
      "egressBytes",
      "coveredConceptIds",
    ], path);
    const referenceId = asString(decision.referenceId, `${path}.referenceId`, 256);
    const classification = asClassification(decision.classification, `${path}.classification`);
    const reference = references.get(referenceId);
    if (!reference || reference.classification !== classification) {
      throw new CoreEdgeContractValidationError(path, "must identify a returned evidence reference with the same classification");
    }
    const covered = asStringArray(decision.coveredConceptIds, `${path}.coveredConceptIds`, 32);
    if (covered.some((id) => !required.has(id))) {
      throw new CoreEdgeContractValidationError(`${path}.coveredConceptIds`, "must be a subset of requiredConceptIds");
    }
    const appliedMode = asEnum(
      decision.appliedMode,
      ["sanitized", "metadata-only"] as const,
      `${path}.appliedMode`,
    );
    const expectedAppliedMode = reference.disclosure === "sanitized-preview"
      ? "sanitized"
      : "metadata-only";
    if (appliedMode !== expectedAppliedMode) {
      throw new CoreEdgeContractValidationError(
        `${path}.appliedMode`,
        "must match the returned evidence disclosure",
      );
    }
    const mode = decision.mode === undefined
      ? undefined
      : asEnum(decision.mode, ["sanitized", "metadata-only"] as const, `${path}.mode`);
    if (mode && mode !== appliedMode) {
      throw new CoreEdgeContractValidationError(`${path}.mode`, "must match appliedMode");
    }
    return {
      referenceId,
      classification,
      plannedMode: asEnum(
        decision.plannedMode,
        ["sanitized", "metadata-only"] as const,
        `${path}.plannedMode`,
      ),
      appliedMode,
      ...(mode ? { mode } : {}),
      egressBytes: asInteger(decision.egressBytes, `${path}.egressBytes`),
      coveredConceptIds: covered,
    };
  });
  return {
    strategy: asEnum(
      plan.strategy,
      ["edge-policy-and-coverage"] as const,
      "response.evidencePlan.strategy",
    ),
    status: asEnum(
      plan.status,
      ["verified", "partial", "unknown", "denied"] as const,
      "response.evidencePlan.status",
    ),
    requiredConceptIds,
    coveredConceptIds,
    missingConceptIds,
    coverage,
    minimumCoverage,
    humanReviewRequired: asBoolean(
      plan.humanReviewRequired,
      "response.evidencePlan.humanReviewRequired",
    ),
    decisions,
  };
}

export function validateCoreEdgeAgentResponse(input: unknown): CoreEdgeAgentResponse {
  const response = asRecord(input, "response");
  exactKeys(response, [
    "version",
    "requestId",
    "agentId",
    "status",
    "summary",
    "evidenceRefs",
    "evidencePlan",
    "policy",
    "metrics",
    "boundary",
    "audit",
  ], "response");
  const agentId = asAgentId(response.agentId, "response.agentId");
  const summaryInput = asRecord(response.summary, "response.summary");
  exactKeys(summaryInput, ["text", "classification", "evidenceIds"], "response.summary");
  if (!Array.isArray(response.evidenceRefs) || response.evidenceRefs.length > 10) {
    throw new CoreEdgeContractValidationError("response.evidenceRefs", "must contain at most 10 references");
  }
  const evidenceRefs = response.evidenceRefs.map((item, index): CoreEvidenceReference => {
    const path = `response.evidenceRefs[${index}]`;
    const reference = asRecord(item, path);
    const classification = asClassification(reference.classification, `${path}.classification`);
    if (reference.disclosure === "sanitized-preview") {
      if (classification !== "public") {
        throw new CoreEdgeContractValidationError(path, "only public evidence may expose a sanitized preview");
      }
      exactKeys(reference, [
        "referenceId",
        "classification",
        "disclosure",
        "title",
        "section",
        "excerpt", "excerptMode", "publishedAt", "sourceSha256", "licenseReview",
        "sourceUrl",
        "retrievalScore",
      ], path);
      return {
        referenceId: asString(reference.referenceId, `${path}.referenceId`, 256),
        classification: "public",
        disclosure: asEnum(reference.disclosure, ["sanitized-preview"] as const, `${path}.disclosure`),
        title: asDlpSafeString(reference.title, `${path}.title`, 512),
        section: asDlpSafeString(reference.section, `${path}.section`, 512),
        excerpt: asDlpSafeString(reference.excerpt, `${path}.excerpt`, reference.excerptMode === "public-passage" ? 1200 : 500),
        ...(reference.excerptMode === undefined ? {} : { excerptMode: asEnum(reference.excerptMode, ["public-passage"] as const, `${path}.excerptMode`) }),
        ...(reference.publishedAt === undefined ? {} : { publishedAt: asDlpSafeString(reference.publishedAt, `${path}.publishedAt`, 100) }),
        ...(reference.sourceSha256 === undefined ? {} : { sourceSha256: asDlpSafeString(reference.sourceSha256, `${path}.sourceSha256`, 64) }),
        ...(reference.licenseReview === undefined ? {} : { licenseReview: asDlpSafeString(reference.licenseReview, `${path}.licenseReview`, 100) }),
        ...(reference.sourceUrl === undefined
          ? {}
          : { sourceUrl: asHttpUrl(reference.sourceUrl, `${path}.sourceUrl`) }),
        retrievalScore: asNumber(reference.retrievalScore, `${path}.retrievalScore`),
      };
    }
    exactKeys(reference, ["referenceId", "classification", "disclosure"], path);
    return {
      referenceId: asString(reference.referenceId, `${path}.referenceId`, 256),
      classification,
      disclosure: asEnum(reference.disclosure, ["reference-only"] as const, `${path}.disclosure`),
    };
  });
  if (new Set(evidenceRefs.map((item) => item.referenceId)).size !== evidenceRefs.length) {
    throw new CoreEdgeContractValidationError("response.evidenceRefs", "referenceId must be unique");
  }
  const evidenceIds = asStringArray(summaryInput.evidenceIds, "response.summary.evidenceIds", 20);
  const referenceIds = new Set(evidenceRefs.map((item) => item.referenceId));
  if (evidenceIds.some((id) => !referenceIds.has(id))) {
    throw new CoreEdgeContractValidationError("response.summary.evidenceIds", "must reference evidenceRefs");
  }

  const policyInput = asRecord(response.policy, "response.policy");
  exactKeys(policyInput, [
    "decisionId",
    "outcome",
    "effectiveClasses",
    "highestEvidenceClassification",
    "redactionCount",
    "blockedCount",
  ], "response.policy");
  const effectiveClasses = asClassificationArray(
    policyInput.effectiveClasses,
    "response.policy.effectiveClasses",
  );
  const agentAllowedClasses = allowedClassesByAgent[agentId];
  if (effectiveClasses.some((classification) => !agentAllowedClasses.includes(classification))) {
    throw new CoreEdgeContractValidationError(
      "response.policy.effectiveClasses",
      `${agentId} Agent classification ceiling exceeded`,
    );
  }
  const summaryClassification = asClassification(
    summaryInput.classification,
    "response.summary.classification",
  );
  if (!effectiveClasses.includes(summaryClassification) ||
      evidenceRefs.some((item) => !effectiveClasses.includes(item.classification))) {
    throw new CoreEdgeContractValidationError("response", "classification is outside effectiveClasses");
  }
  const reportedHighest = policyInput.highestEvidenceClassification === null
    ? null
    : asClassification(
        policyInput.highestEvidenceClassification,
        "response.policy.highestEvidenceClassification",
      );
  if (reportedHighest !== highestClassification(evidenceRefs)) {
    throw new CoreEdgeContractValidationError(
      "response.policy.highestEvidenceClassification",
      "must match evidenceRefs",
    );
  }

  const metricsInput = asRecord(response.metrics, "response.metrics");
  exactKeys(metricsInput, [
    "backend",
    "answerSource",
    "model",
    "fallbackReasonCode",
    "evidenceCount",
    "sourceBytesProcessed",
    "egressBytes",
    "latencyMs",
    "ttftMs",
    "tpotMs",
    "tokensPerSecond",
    "promptTokens",
    "completionTokens",
    "corpusChunks",
  ], "response.metrics");
  const evidenceCount = asInteger(metricsInput.evidenceCount, "response.metrics.evidenceCount", 10);
  if (evidenceCount !== evidenceRefs.length) {
    throw new CoreEdgeContractValidationError("response.metrics.evidenceCount", "must match evidenceRefs");
  }

  const boundaryInput = asRecord(response.boundary, "response.boundary");
  exactKeys(boundaryInput, [
    "transport",
    "rawCorpusTransferred",
    "returnedBytes",
    "evidencePayloadBytes",
    "restrictedEvidenceCount",
  ], "response.boundary");
  if (boundaryInput.rawCorpusTransferred !== false) {
    throw new CoreEdgeContractValidationError("response.boundary.rawCorpusTransferred", "must be false");
  }
  const restrictedEvidenceCount = asInteger(
    boundaryInput.restrictedEvidenceCount,
    "response.boundary.restrictedEvidenceCount",
    10,
  );
  if (restrictedEvidenceCount !== evidenceRefs.filter((item) => item.classification !== "public").length) {
    throw new CoreEdgeContractValidationError(
      "response.boundary.restrictedEvidenceCount",
      "must match restricted evidenceRefs",
    );
  }
  const evidencePayloadBytes = asInteger(
    boundaryInput.evidencePayloadBytes,
    "response.boundary.evidencePayloadBytes",
  );
  if (evidencePayloadBytes !== encoder.encode(JSON.stringify(evidenceRefs)).length) {
    throw new CoreEdgeContractValidationError(
      "response.boundary.evidencePayloadBytes",
      "must match serialized evidenceRefs",
    );
  }

  const auditInput = asRecord(response.audit, "response.audit");
  exactKeys(auditInput, ["eventId", "recordedAt", "policyVersion", "policyDecisionId"], "response.audit");
  const recordedAt = asString(auditInput.recordedAt, "response.audit.recordedAt", 64);
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new CoreEdgeContractValidationError("response.audit.recordedAt", "must be an ISO date-time");
  }

  const policyDecisionId = asString(auditInput.policyDecisionId, "response.audit.policyDecisionId", 256);
  const decisionId = asString(policyInput.decisionId, "response.policy.decisionId", 256);
  if (policyDecisionId !== decisionId) {
    throw new CoreEdgeContractValidationError(
      "response.audit.policyDecisionId",
      "must match response.policy.decisionId",
    );
  }

  const evidencePlan = response.evidencePlan === undefined
    ? undefined
    : validateEvidencePlan(response.evidencePlan, evidenceRefs);
  return {
    version: asEnum(response.version, [EDGE_CORE_CONTRACT_VERSION] as const, "response.version"),
    requestId: asString(response.requestId, "response.requestId", 128),
    agentId,
    status: asEnum(
      response.status,
      ["completed", "fallback", "insufficient-evidence", "denied"] as const,
      "response.status",
    ),
    summary: {
      text: asString(summaryInput.text, "response.summary.text", 4_000),
      classification: summaryClassification,
      evidenceIds,
    },
    evidenceRefs,
    ...(evidencePlan ? { evidencePlan } : {}),
    policy: {
      decisionId,
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
      ...(metricsInput.fallbackReasonCode === undefined
        ? {}
        : {
            fallbackReasonCode: asEnum(
              metricsInput.fallbackReasonCode,
              ["not-configured", "empty-response", "timeout", "http-error", "connection-error", "edge-status", "unknown"] as const,
              "response.metrics.fallbackReasonCode",
            ),
          }),
      evidenceCount,
      sourceBytesProcessed: asInteger(metricsInput.sourceBytesProcessed, "response.metrics.sourceBytesProcessed"),
      egressBytes: asInteger(metricsInput.egressBytes, "response.metrics.egressBytes"),
      latencyMs: asInteger(metricsInput.latencyMs, "response.metrics.latencyMs"),
      ttftMs: asNullableNumber(metricsInput.ttftMs, "response.metrics.ttftMs"),
      tpotMs: asNullableNumber(metricsInput.tpotMs, "response.metrics.tpotMs"),
      ...(metricsInput.tokensPerSecond === undefined ? {} : {
        tokensPerSecond: asNullableNumber(metricsInput.tokensPerSecond, "response.metrics.tokensPerSecond"),
      }),
      promptTokens: asNullableNumber(metricsInput.promptTokens, "response.metrics.promptTokens"),
      completionTokens: asNullableNumber(metricsInput.completionTokens, "response.metrics.completionTokens"),
      corpusChunks: asInteger(metricsInput.corpusChunks, "response.metrics.corpusChunks"),
    },
    boundary: {
      transport: asEnum(boundaryInput.transport, ["local", "http"] as const, "response.boundary.transport"),
      rawCorpusTransferred: false,
      returnedBytes: asInteger(boundaryInput.returnedBytes, "response.boundary.returnedBytes"),
      evidencePayloadBytes,
      restrictedEvidenceCount,
    },
    audit: {
      eventId: asString(auditInput.eventId, "response.audit.eventId", 256),
      recordedAt,
      policyVersion: asString(auditInput.policyVersion, "response.audit.policyVersion", 128),
      policyDecisionId,
    },
  };
}

type ExtendedEdgeDecision = EdgeAgentResponse["evidencePlan"] extends infer Plan
  ? Plan extends { decisions: Array<infer Decision> }
    ? Decision & {
        plannedMode?: EdgeEvidenceMode;
        appliedMode?: EdgeEvidenceMode;
        egressBytes?: number;
      }
    : never
  : never;

function fallbackReasonCode(response: EdgeAgentResponse): CoreFallbackReasonCode | undefined {
  if (response.metrics.answerSource !== "deterministic-fallback") return undefined;
  const reason = response.metrics.fallbackReason?.toLowerCase() ?? "";
  if (reason.includes("base_url") || reason.includes("not configured") || reason.includes("설정")) {
    return "not-configured";
  }
  if (reason.includes("empty response")) return "empty-response";
  if (reason.includes("timeout") || reason.includes("timed out") || reason.includes("abort")) return "timeout";
  if (reason.includes("http")) return "http-error";
  if (reason.includes("fetch") || reason.includes("connect") || reason.includes("econn")) return "connection-error";
  if (response.status !== "completed") return "edge-status";
  return "unknown";
}

export function projectEdgeAgentResponseForCore(
  response: EdgeAgentResponse,
  transport: EdgeTransport = response.boundary.transport,
): CoreEdgeAgentResponse {
  const evidenceRefs: CoreEvidenceReference[] = response.evidence.map((item) => {
    if (item.classification === "public" && item.disclosure === "excerpt") {
      return {
        referenceId: item.referenceId,
        classification: "public",
        disclosure: "sanitized-preview",
        title: sanitizeSensitiveText(item.title).sanitized,
        section: sanitizeSensitiveText(item.section).sanitized,
        excerpt: sanitizeSensitiveText(item.excerpt).sanitized,
        ...(item.excerptMode ? { excerptMode: item.excerptMode } : {}),
        ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        ...(item.sourceSha256 ? { sourceSha256: item.sourceSha256 } : {}),
        ...(item.licenseReview ? { licenseReview: item.licenseReview } : {}),
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        retrievalScore: item.retrievalScore,
      };
    }
    return {
      referenceId: item.referenceId,
      classification: item.classification,
      disclosure: "reference-only",
    };
  });
  const references = new Map(evidenceRefs.map((item) => [item.referenceId, item]));
  const evidencePlan: CoreEvidencePlan | undefined = response.evidencePlan
    ? {
        strategy: response.evidencePlan.strategy,
        status: response.evidencePlan.status,
        requiredConceptIds: [...response.evidencePlan.requiredConceptIds],
        coveredConceptIds: [...response.evidencePlan.coveredConceptIds],
        missingConceptIds: [...response.evidencePlan.missingConceptIds],
        coverage: response.evidencePlan.coverage,
        minimumCoverage: response.evidencePlan.minimumCoverage,
        humanReviewRequired: response.evidencePlan.humanReviewRequired,
        decisions: response.evidencePlan.decisions.map((inputDecision) => {
          const decision = inputDecision as ExtendedEdgeDecision;
          const reference = references.get(decision.referenceId);
          const plannedMode = decision.plannedMode ?? decision.mode;
          return {
            referenceId: decision.referenceId,
            classification: decision.classification,
            plannedMode,
            appliedMode: reference?.disclosure === "sanitized-preview" ? "sanitized" : "metadata-only",
            mode: reference?.disclosure === "sanitized-preview" ? "sanitized" : "metadata-only",
            egressBytes: reference ? encoder.encode(JSON.stringify(reference)).length : 0,
            coveredConceptIds: [...decision.coveredConceptIds],
          };
        }),
      }
    : undefined;
  const projected: CoreEdgeAgentResponse = {
    version: EDGE_CORE_CONTRACT_VERSION,
    requestId: response.requestId,
    agentId: response.agentId,
    status: response.status,
    summary: {
      text: response.answer.text,
      classification: response.answer.classification,
      evidenceIds: [...response.answer.citations],
    },
    evidenceRefs,
    ...(evidencePlan ? { evidencePlan } : {}),
    policy: {
      decisionId: response.policy.decisionId,
      outcome: response.policy.outcome,
      effectiveClasses: [...response.policy.effectiveClasses],
      highestEvidenceClassification: response.policy.highestEvidenceClassification,
      redactionCount: response.policy.redactionCount,
      blockedCount: response.policy.blockedCount,
    },
    metrics: {
      backend: response.metrics.backend,
      answerSource: response.metrics.answerSource,
      model: response.metrics.model,
      ...(fallbackReasonCode(response) ? { fallbackReasonCode: fallbackReasonCode(response) } : {}),
      evidenceCount: evidenceRefs.length,
      sourceBytesProcessed: response.metrics.sourceBytesProcessed,
      egressBytes: 0,
      latencyMs: response.metrics.latencyMs,
      ttftMs: response.metrics.ttftMs,
      tpotMs: response.metrics.tpotMs,
      ...(response.metrics.tokensPerSecond === undefined ? {} : { tokensPerSecond: response.metrics.tokensPerSecond }),
      promptTokens: response.metrics.promptTokens,
      completionTokens: response.metrics.completionTokens,
      corpusChunks: response.metrics.corpusChunks,
    },
    boundary: {
      transport,
      rawCorpusTransferred: false,
      returnedBytes: 0,
      evidencePayloadBytes: encoder.encode(JSON.stringify(evidenceRefs)).length,
      restrictedEvidenceCount: evidenceRefs.filter((item) => item.classification !== "public").length,
    },
    audit: {
      eventId: response.audit.eventId,
      recordedAt: response.audit.recordedAt,
      policyVersion: response.audit.policyVersion,
      policyDecisionId: response.policy.decisionId,
    },
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = encoder.encode(JSON.stringify(projected)).length;
    if (projected.metrics.egressBytes === bytes && projected.boundary.returnedBytes === bytes) {
      return validateCoreEdgeAgentResponse(projected);
    }
    projected.metrics.egressBytes = bytes;
    projected.boundary.returnedBytes = bytes;
  }
  throw new Error("CORE_EDGE_RESPONSE_SIZE_DID_NOT_CONVERGE");
}

export function isCoreEdgeAgentResponse(input: unknown): input is CoreEdgeAgentResponse {
  try {
    validateCoreEdgeAgentResponse(input);
    return true;
  } catch {
    return false;
  }
}
