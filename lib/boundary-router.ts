import { agentProfiles, type AgentId } from "./knowledge";

export type QueryClassification = "public" | "internal" | "confidential";
export type QueryPurpose = "advice" | "decision" | "audit";

export type BoundaryPolicy = {
  classification: QueryClassification;
  purpose: QueryPurpose;
  minimumCoverage: number;
  maxAgents: number;
  deadlineMs: number;
};

export type AgentRoutingEstimate = {
  id: AgentId;
  probability: number;
  missCost: number;
  callCost: number;
  byteCost: number;
  latencyCost: number;
  utility: number;
  allowed: boolean;
  signals: string[];
};

export type BoundaryRoutingDecision = {
  selected: AgentId[];
  required: AgentId[];
  estimates: AgentRoutingEstimate[];
  policy: BoundaryPolicy;
  predictedCoverage: number;
  objectiveCost: number;
  adaptiveAdditions: AgentId[];
  strategy: "lightweight-threshold" | "boundary-constrained";
  complexityScore: number;
  rationale: string;
};

const criticalMissCost: Partial<Record<AgentId, number>> = {
  security: 1.45,
  legal: 1.35,
  operations: 1.15,
  data: 1.1,
};

const coupledDomains: Array<{ pattern: RegExp; agents: AgentId[] }> = [
  { pattern: /민원|개인정보|주민등록|가명|민감/i, agents: ["security", "legal"] },
  { pattern: /발주|입찰|조달|규격서|사업자/i, agents: ["procurement", "finance"] },
  { pattern: /ai|llm|rag|생성형|모델/i, agents: ["tech"] },
  { pattern: /운영|sla|장애|가용성|응답시간|품질/i, agents: ["operations"] },
];

function normalize(text: string) {
  return text.toLowerCase();
}

function semanticScore(query: string, profile: string) {
  const left = new Set(normalize(query).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length > 1));
  const right = new Set(normalize(profile).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length > 1));
  const intersection = [...left].filter((token) =>
    [...right].some((candidate) => candidate.includes(token) || token.includes(candidate)),
  ).length;
  return intersection / Math.sqrt(Math.max(left.size * right.size, 1));
}

function inferPolicy(query: string): BoundaryPolicy {
  const classification: QueryClassification =
    /주민등록|민감|기밀|비밀|내부 ip|관리계정/i.test(query)
      ? "confidential"
      : /내부|민원|고객|직원|계약/i.test(query)
        ? "internal"
        : "public";
  const purpose: QueryPurpose =
    /감사|점검|준수|컴플라이언스/i.test(query)
      ? "audit"
      : /결정|승인|발주|도입|계약/i.test(query)
        ? "decision"
        : "advice";
  return {
    classification,
    purpose,
    minimumCoverage: purpose === "decision" || classification === "confidential" ? 0.92 : 0.84,
    maxAgents: purpose === "audit" ? 7 : 6,
    deadlineMs: 15_000,
  };
}

function requiredAgents(query: string, scores: Record<AgentId, number>) {
  const required = new Set<AgentId>();
  const privacyNegated = /개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/i.test(query);
  for (const [id, score] of Object.entries(scores) as [AgentId, number][]) {
    if (score > 0 && !(privacyNegated && (id === "security" || id === "legal"))) required.add(id);
  }
  for (const coupling of coupledDomains) {
    if (privacyNegated && coupling.agents.includes("security")) continue;
    if (coupling.pattern.test(query)) coupling.agents.forEach((id) => required.add(id));
  }
  if (!required.size) required.add("tech");
  return [...required];
}

export function routeWithBoundaryConstraints(
  query: string,
  lexicalScores: Record<AgentId, number>,
): BoundaryRoutingDecision {
  const policy = inferPolicy(query);
  const required = requiredAgents(query, lexicalScores);
  const normalized = normalize(query);
  const estimates = (Object.keys(agentProfiles) as AgentId[]).map((id) => {
    const profile = agentProfiles[id];
    const signals = profile.keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
    const coupled = required.includes(id);
    const probability = Math.min(0.99, 0.08 + signals.length * 0.19 + (coupled ? 0.24 : 0));
    const missCost = (criticalMissCost[id] ?? 1) *
      (policy.purpose === "decision" ? 1.15 : 1) *
      (policy.classification === "confidential" && (id === "security" || id === "legal") ? 1.25 : 1);
    const callCost = 0.19;
    const byteCost = 0.035;
    const latencyCost = 0.025;
    // 질의 등급은 Agent 실행 자격을 제한하되, confidential 질의라도 해당
    // Agent가 internal 이상 문서를 다룰 수 있으면 최소 공개 contract로 참여한다.
    // 실제 검색 문서는 retrieve 단계에서 profile.allowedClasses로 다시 제한한다.
    const allowed = profile.allowedClasses.includes(policy.classification) ||
      (policy.classification === "confidential" && profile.allowedClasses.includes("internal"));
    const utility = probability * missCost - callCost - byteCost - latencyCost;
    return {
      id,
      probability: Number(probability.toFixed(3)),
      missCost: Number(missCost.toFixed(3)),
      callCost,
      byteCost,
      latencyCost,
      utility: Number(utility.toFixed(3)),
      allowed,
      signals,
    };
  });

  const allowedRequired = estimates
    .filter((item) => item.allowed && required.includes(item.id))
    .sort((a, b) => b.utility - a.utility);
  const conjunctions = (query.match(/그리고|및|동시에|종합|각각|뿐만 아니라/g) ?? []).length;
  const complexityScore = Math.min(
    1,
    required.length / 5 +
      conjunctions * 0.12 +
      (policy.purpose === "decision" ? 0.18 : 0) +
      (policy.purpose === "audit" ? 0.2 : 0) +
      (policy.classification === "confidential" ? 0.25 : 0),
  );
  const strategy: BoundaryRoutingDecision["strategy"] =
    process.env.ENABLE_LIGHTWEIGHT_HYBRID === "true" &&
    required.length <= 2 &&
    complexityScore < 0.55 &&
    policy.purpose === "advice" &&
    policy.classification !== "confidential"
      ? "lightweight-threshold"
      : "boundary-constrained";
  const totalRequiredProbability = allowedRequired.reduce((sum, item) => sum + item.probability, 0);
  const selected: AgentId[] = [];
  let coveredProbability = 0;
  if (strategy === "lightweight-threshold") {
    const semanticRank = estimates
      .filter((item) => item.allowed)
      .map((item) => ({
        ...item,
        semantic: semanticScore(query, `${agentProfiles[item.id].responsibility} ${agentProfiles[item.id].keywords.join(" ")}`),
      }))
      .sort((a, b) => b.semantic - a.semantic);
    const thresholded = semanticRank.filter((item) => item.semantic >= 0.15).slice(0, 3);
    for (const estimate of thresholded.length ? thresholded : semanticRank.slice(0, 1)) {
      selected.push(estimate.id);
      coveredProbability += estimate.probability;
    }
  } else {
    for (const estimate of allowedRequired) {
      if (selected.length >= policy.maxAgents) break;
      if (estimate.utility > 0 || coveredProbability / Math.max(totalRequiredProbability, 0.001) < policy.minimumCoverage) {
        selected.push(estimate.id);
        coveredProbability += estimate.probability;
      }
    }
  }

  const adaptiveAdditions: AgentId[] = [];
  const coverage = coveredProbability / Math.max(totalRequiredProbability, 0.001);
  if (strategy === "boundary-constrained" && coverage < policy.minimumCoverage) {
    for (const estimate of allowedRequired) {
      if (selected.includes(estimate.id) || selected.length >= policy.maxAgents) continue;
      selected.push(estimate.id);
      adaptiveAdditions.push(estimate.id);
      coveredProbability += estimate.probability;
      if (coveredProbability / Math.max(totalRequiredProbability, 0.001) >= policy.minimumCoverage) break;
    }
  }
  if (!selected.length) selected.push("tech");

  const chosen = estimates.filter((item) => selected.includes(item.id));
  return {
    selected,
    required,
    estimates,
    policy,
    predictedCoverage: Number(
      Math.min(1, coveredProbability / Math.max(totalRequiredProbability, 0.001)).toFixed(3),
    ),
    objectiveCost: Number(
      chosen.reduce((sum, item) => sum + item.callCost + item.byteCost + item.latencyCost, 0).toFixed(3),
    ),
    adaptiveAdditions,
    strategy,
    complexityScore: Number(complexityScore.toFixed(3)),
    rationale: strategy === "lightweight-threshold"
      ? "저복잡도·저위험 질의로 판정해 semantic threshold 경로를 적용했습니다."
      : `누락 기대손실과 호출·통신·지연 비용을 비교하고 ${Math.round(policy.minimumCoverage * 100)}% coverage 및 ${policy.classification} 경계 정책을 적용했습니다.`,
  };
}

export type MinimalAgentOutput = {
  decision: string;
  confidence: number;
  requiredActions: string[];
  evidenceHandles: string[];
  disclosureLevel: "minimal" | "standard";
  unresolvedConflicts: string[];
};

export function toMinimalAgentOutput(input: {
  summary: string;
  score: number;
  evidenceIds: string[];
}): MinimalAgentOutput {
  const lines = input.summary.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return {
    decision: (lines.find((line) => line.startsWith("판단:")) ?? lines[0] ?? "판단 보류")
      .replace(/^판단:\s*/, "").replace(/\[[^\]]+\]/g, "").trim(),
    confidence: Number(Math.min(0.99, Math.max(0.5, input.score / 100)).toFixed(2)),
    requiredActions: lines
      .filter((line) => line.startsWith("필수 조치:"))
      .map((line) => line.replace(/^필수 조치:\s*/, "").replace(/\[[^\]]+\]/g, "").trim()),
    evidenceHandles: input.evidenceIds,
    disclosureLevel: "minimal",
    unresolvedConflicts: [],
  };
}
