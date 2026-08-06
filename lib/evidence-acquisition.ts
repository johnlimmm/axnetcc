import type { AgentId } from "./knowledge";

export const evidenceModes = ["raw", "sanitized", "local-summary", "metadata-only"] as const;
export type EvidenceMode = typeof evidenceModes[number];
export type SecurityLevel = "public" | "internal" | "confidential" | "personal";
export type EvidenceStrategy = "legacy" | "raw-central" | "always-local" | "fixed-sanitized" | "network-only" | "security-only" | "axnetcc-saea" | "oracle-feasible";

export type EvidenceCandidate = {
  id: string;
  canonicalId: string;
  title: string;
  section: string;
  ownerDepartment: AgentId;
  securityLevel: SecurityLevel;
  effectiveDate: string;
  text: string;
  requiredConcepts: string[];
  conceptAliases?: Record<string, string[]>;
};

export type NetworkScenario = {
  name: string;
  latencyMs: number;
  jitterMs: number;
  bandwidthBytesPerSecond: number;
  lossRate: number;
  timeoutMs: number;
  ownerProcessingMultiplier: number;
};

const roleThresholds: Record<AgentId, number> = {
  tech: 0.7, data: 0.75, security: 0.8, legal: 0.8,
  policy: 0.7, finance: 0.7, procurement: 0.75, operations: 0.75,
};

const sensitivityWeights: Record<SecurityLevel, number> = {
  public: 1, internal: 2, confidential: 5, personal: 8,
};

const sensitivePatterns = [
  /\b\d{6}-?[1-4]\d{6}\b/g,
  /\b01[016789]-?\d{3,4}-?\d{4}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){3}\b/g,
  /\b(?:account|계좌)\s*[:#]?\s*[\d-]{8,}\b/gi,
  /\b(?:secret|sensitive|민감)\s*[:=]\s*[^\s,;]+/gi,
];

function bytes(value: unknown) { return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length; }
function normalized(text: string) { return text.normalize("NFKC").toLowerCase(); }
function tokens(text: string) {
  const value = normalized(text);
  const words = value.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const compact = value.replace(/[^\p{L}\p{N}]/gu, "");
  const bigrams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  return new Set([...words, ...bigrams]);
}

export function policyAllows(level: SecurityLevel, mode: EvidenceMode, owner: AgentId, requester: AgentId | "core", requesterZone: string) {
  const ownerLocal = requester === owner && requesterZone === owner;
  if (level === "public") return true;
  if (level === "internal") return mode !== "raw" || ownerLocal;
  if (level === "confidential") return mode === "raw" ? ownerLocal : (mode !== "sanitized" || requester === owner || requester === "security" || requester === "legal");
  return mode !== "raw" && (mode !== "sanitized" || requester === "security" || requester === "legal");
}

export function transformEvidence(candidate: EvidenceCandidate, mode: EvidenceMode) {
  const started = performance.now();
  let removedSensitiveFieldCount = 0;
  let content: string | undefined;
  if (mode === "raw") content = candidate.text;
  if (mode === "sanitized") {
    content = candidate.text;
    for (const pattern of sensitivePatterns) {
      content = content.replace(pattern, () => { removedSensitiveFieldCount += 1; return "[REDACTED]"; });
    }
  }
  if (mode === "local-summary") {
    const sentences = candidate.text.split(/(?<=[.!?。]|다\.)\s+/).filter(Boolean);
    const conceptTokens = tokens(candidate.requiredConcepts.flatMap((concept) => [concept, ...(candidate.conceptAliases?.[concept] ?? [])]).join(" "));
    content = sentences
      .map((sentence) => ({ sentence, score: [...tokens(sentence)].filter((token) => conceptTokens.has(token)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2).map((item) => item.sentence).join(" ").slice(0, 700);
    content = `[evidence:${candidate.id}] ${content}`;
  }
  const result = {
    documentId: candidate.id,
    canonicalId: candidate.canonicalId,
    title: candidate.title,
    section: candidate.section,
    ownerDepartment: candidate.ownerDepartment,
    securityLevel: candidate.securityLevel,
    effectiveDate: candidate.effectiveDate,
    contentByteLength: bytes(candidate.text),
    ...(content === undefined ? {} : { content }),
  };
  return { evidence: result, removedSensitiveFieldCount, transformationMs: Number((performance.now() - started).toFixed(3)), responseBytes: bytes(result) };
}

export function conceptCoverage(requiredConcepts: string[], transformed: ReturnType<typeof transformEvidence>["evidence"], conceptAliases: Record<string, string[]> = {}) {
  if (!requiredConcepts.length) return 1;
  if (!("content" in transformed)) return 0;
  const haystack = tokens(`${transformed.title} ${transformed.section} ${"content" in transformed ? transformed.content : ""}`);
  const matched = requiredConcepts.filter((concept) => [concept, ...(conceptAliases[concept] ?? [])].some((variant) => {
    const serialized = normalized(JSON.stringify(transformed));
    if (serialized.includes(normalized(variant))) return true;
    const words = normalized(variant).match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    if (words.length > 1) return words.filter((word) => haystack.has(word)).length / words.length >= 0.8;
    const conceptTokens = [...tokens(variant)];
    return conceptTokens.filter((token) => haystack.has(token)).length / Math.max(conceptTokens.length, 1) >= 0.8;
  }));
  return Number((matched.length / requiredConcepts.length).toFixed(4));
}

function networkEstimate(responseBytes: number, scenario: NetworkScenario) {
  return scenario.latencyMs + responseBytes / Math.max(1, scenario.bandwidthBytesPerSecond) * 1000;
}

export function planEvidence(input: {
  query: string;
  selectedRoles: AgentId[];
  candidateEvidenceByRole: Partial<Record<AgentId, EvidenceCandidate[]>>;
  strategy: EvidenceStrategy;
  networkScenario: NetworkScenario;
  requesterZone: string;
  requesterRole?: AgentId | "core";
  ablation?: "without-policy" | "without-coverage" | "without-sensitivity" | "without-network" | "weighted";
  observedCosts?: Partial<Record<EvidenceMode, number>>;
}) {
  const decisions: Array<Record<string, unknown>> = [];
  const infeasibleRoles: AgentId[] = [];
  const policyTrace: Array<Record<string, unknown>> = [];
  const coverageTrace: Array<Record<string, unknown>> = [];
  const costTrace: Array<Record<string, unknown>> = [];
  for (const role of input.selectedRoles) {
    const candidates = input.candidateEvidenceByRole[role] ?? [];
    let chosen: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      const options = evidenceModes.map((mode) => {
        const transformed = transformEvidence(candidate, mode);
        const coverage = conceptCoverage(candidate.requiredConcepts, transformed.evidence, candidate.conceptAliases);
        const allowed = input.ablation === "without-policy" || policyAllows(candidate.securityLevel, mode, candidate.ownerDepartment, input.requesterRole ?? "core", input.requesterZone);
        const coverageOk = input.ablation === "without-coverage" || coverage >= roleThresholds[role];
        const crossBoundary = input.requesterZone !== candidate.ownerDepartment;
        const crossBytes = crossBoundary ? transformed.responseBytes : 0;
        const sensitiveBytes = input.ablation === "without-sensitivity" ? crossBytes : crossBytes * sensitivityWeights[candidate.securityLevel];
        const localProcessingEstimateMs = mode === "raw" ? 0 : mode === "metadata-only" ? 0.02 : mode === "sanitized" ? bytes(candidate.text) * 0.002 : bytes(candidate.text) * 0.01;
        const predictedMs = (input.ablation === "without-network" ? 0 : networkEstimate(transformed.responseBytes, input.networkScenario)) + localProcessingEstimateMs * input.networkScenario.ownerProcessingMultiplier;
        const objective = [sensitiveBytes, predictedMs, crossBytes, localProcessingEstimateMs];
        const weighted = sensitiveBytes * 0.5 + predictedMs * 0.3 + crossBytes * 0.15 + localProcessingEstimateMs * 0.05;
        policyTrace.push({ role, evidenceId: candidate.id, mode, allowed });
        coverageTrace.push({ role, evidenceId: candidate.id, mode, coverage, threshold: roleThresholds[role], accepted: coverageOk });
        costTrace.push({ role, evidenceId: candidate.id, mode, objective, weighted });
        return { candidate, mode, transformed, coverage, allowed, coverageOk, objective, weighted, predictedMs };
      });
      const feasible = options.filter((option) => option.allowed && option.coverageOk);
      const strategy = input.strategy;
      let selected = strategy === "raw-central" ? options.find((o) => o.mode === "raw") :
        strategy === "always-local" ? options.find((o) => o.mode === "local-summary" && o.allowed) ?? options.find((o) => o.mode === "metadata-only") :
        strategy === "fixed-sanitized" ? options.find((o) => o.mode === "sanitized" && o.allowed) ?? options.find((o) => o.mode === "local-summary" && o.allowed) ?? options.find((o) => o.mode === "metadata-only") :
        strategy === "network-only" ? [...options].sort((a, b) => a.predictedMs - b.predictedMs)[0] :
        strategy === "security-only" ? evidenceModes.slice().reverse().map((mode) => options.find((o) => o.mode === mode && o.allowed)).find(Boolean) : undefined;
      if (strategy === "axnetcc-saea" || strategy === "oracle-feasible" || input.ablation) {
        selected = [...feasible].sort((a, b) => input.ablation === "weighted" ? a.weighted - b.weighted : compareTuple(a.objective, b.objective))[0];
      }
      if (selected) {
        const policyViolation = !selected.allowed;
        chosen = { role, evidenceId: candidate.id, mode: selected.mode, coverage: selected.coverage, policyViolation, policyBypassForExperiment: policyViolation, predictedEndToEndMs: selected.predictedMs, ...selected.transformed };
        break;
      }
    }
    if (chosen) decisions.push(chosen);
    else infeasibleRoles.push(role);
  }
  return { decisions, infeasibleRoles, policyTrace, coverageTrace, costTrace, infeasible: infeasibleRoles.length > 0, humanReviewRequired: infeasibleRoles.length > 0, reason: infeasibleRoles.length ? `No policy-and-coverage-feasible evidence for: ${infeasibleRoles.join(", ")}` : undefined };
}

function compareTuple(left: number[], right: number[]) {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
