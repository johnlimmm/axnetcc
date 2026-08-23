import { agentIds, agentProfiles, type AgentId } from "./agent-registry";

export type RoutingSecurityLevel = "public" | "internal" | "confidential" | "personal";
export type RoutingPurpose = "advice" | "decision" | "audit";
export type AgentExecutionRole = "primary" | "required-reviewer" | "supporting";

export type RequiredConcept = {
  id: string;
  label: string;
  owner: AgentId;
  aliases: string[];
};

export type AgentRoutingEstimate = {
  id: AgentId;
  probability: number;
  missCost: number;
  callCost: number;
  byteCost: number;
  latencyCost: number;
  utility: number;
  signals: string[];
};

export type PrimaryRoutingScore = {
  agentId: AgentId;
  rank: number;
  totalScore: number;
  components: {
    profileSimilarity: number;
    keywordEntity: number;
    evidenceReadiness: number;
    missRisk: number;
    costEfficiency: number;
    domainSignal: number;
  };
  matchedTerms: string[];
  matchedEntities: string[];
  matchedConceptIds: string[];
};

export type PrimaryRoutingSelection = {
  algorithm: "hybrid-profile-v1";
  hardGate: {
    applied: boolean;
    forcedAgent: AgentId | null;
    reasons: string[];
  };
  rankedCandidates: PrimaryRoutingScore[];
  confidence: number;
  top1Top2Margin: number;
  decisionThreshold: number;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  reviewReasons: string[];
};

export type BoundaryRoutingDecision = {
  version: "2";
  strategy: "boundary-constrained";
  securityLevel: RoutingSecurityLevel;
  purpose: RoutingPurpose;
  primaryAgent: AgentId;
  candidateAgents: AgentId[];
  required: AgentId[];
  selected: AgentId[];
  supportingAgents: AgentId[];
  requiredConcepts: RequiredConcept[];
  estimates: AgentRoutingEstimate[];
  primarySelection: PrimaryRoutingSelection;
  predictedCoverage: number;
  objectiveCost: number;
  adaptiveAdditions: AgentId[];
  humanReviewRequired: boolean;
  rationale: string[];
};

export type ObservedAgentOutput = {
  status: "completed" | "fallback" | "insufficient-evidence" | "denied";
  policyOutcome: "allow" | "redact" | "deny";
  evidenceCoverage?: {
    coveredConceptIds: string[];
    missingConceptIds: string[];
    coverage: number | null;
    humanReviewRequired: boolean;
  };
};

export type AdaptiveRoutingDecision = {
  additions: AgentId[];
  coveredConceptIds: string[];
  missingConceptIds: string[];
  coverage: number | null;
  humanReviewRequired: boolean;
  rationale: string;
};

const roleConcepts: Record<AgentId, RequiredConcept[]> = {
  tech: [
    { id: "technical-architecture", label: "기술 아키텍처", owner: "tech", aliases: ["아키텍처", "구성", "시스템", "RAG", "모델"] },
    { id: "performance-quality", label: "성능·품질 기준", owner: "tech", aliases: ["성능", "품질", "응답시간", "정확도", "PoC"] },
  ],
  data: [
    { id: "data-provenance", label: "데이터 출처", owner: "data", aliases: ["출처", "수집", "메타데이터", "원천"] },
    { id: "data-lifecycle", label: "데이터 품질·수명주기", owner: "data", aliases: ["품질", "갱신", "보유", "폐기", "수명주기"] },
  ],
  security: [
    { id: "data-minimization", label: "개인정보 최소처리", owner: "security", aliases: ["최소처리", "최소 수집", "마스킹", "가명", "개인정보"] },
    { id: "access-control", label: "접근통제", owner: "security", aliases: ["접근통제", "최소권한", "권한", "인증", "암호화"] },
    { id: "security-audit", label: "보안 감사·추적", owner: "security", aliases: ["감사로그", "감사 로그", "이상행위", "추적", "로그"] },
  ],
  legal: [
    { id: "lawful-basis", label: "법적 근거", owner: "legal", aliases: ["법적 근거", "처리 근거", "법령", "동의", "규정"] },
    { id: "legal-accountability", label: "책임·계약 조건", owner: "legal", aliases: ["책임", "계약", "위탁", "재위탁", "조항"] },
  ],
  policy: [
    { id: "transparency", label: "투명성·설명가능성", owner: "policy", aliases: ["투명성", "설명가능", "고지", "이의제기"] },
    { id: "impact-assessment", label: "영향평가", owner: "policy", aliases: ["영향평가", "편향", "공정성", "인권", "공공성"] },
  ],
  finance: [
    { id: "total-cost", label: "총소유비용", owner: "finance", aliases: ["총소유비용", "TCO", "운영비", "유지보수비", "비용"] },
    { id: "budget-control", label: "예산 통제", owner: "finance", aliases: ["예산", "단가", "재원", "비용 통제", "타당성"] },
  ],
  procurement: [
    { id: "competitive-procurement", label: "경쟁 조달", owner: "procurement", aliases: ["경쟁", "입찰", "발주", "조달", "수의계약"] },
    { id: "vendor-exit", label: "사업자 종속·종료 조건", owner: "procurement", aliases: ["종속", "이전", "종료", "규격서", "사업자"] },
  ],
  operations: [
    { id: "service-level", label: "서비스 수준", owner: "operations", aliases: ["SLA", "가용성", "응답시간", "복구시간", "품질"] },
    { id: "incident-operations", label: "장애·운영 절차", owner: "operations", aliases: ["장애", "모니터링", "대응", "운영 전환", "검수"] },
  ],
};

const conceptCatalog = new Map(
  Object.values(roleConcepts).flat().map((concept) => [concept.id, concept] as const),
);

const criticalMissCost: Partial<Record<AgentId, number>> = {
  security: 1.55,
  legal: 1.45,
  operations: 1.2,
  data: 1.15,
};

/** 넓은 단어 하나가 주관 역할을 독점하지 않도록 업무 행위 단위로 라우팅 신호를 정의한다. */
const domainRoleSignals: Record<AgentId, RegExp[]> = {
  tech: [
    /기술\s*구성|아키텍처|RAG|PoC|성능\s*기준|응답시간|환각|검색\s*품질|근거\s*연결/i,
    /모델\s*업데이트|정확도\s*저하|대체\s*절차|담당자\s*이관|프롬프트|레드팀/i,
    /상용\s*LLM|내부\s*LLM.*외부\s*클라우드|클라우드.*성능|정량적\s*성과|빠르게\s*구축/i,
    /근거성|기밀문서.*RAG|전국\s*기관|확산|확장|생성형\s*AI.*도입/i,
  ],
  data: [
    /학습데이터|학습에\s*사용|데이터셋|데이터.*출처|라벨|메타데이터|갱신|최신성|폐기/i,
    /표준화|공공데이터|지식베이스.*수집|문서.*버전|검색\s*품질/i,
    /데이터.*공동\s*활용|공동\s*활용.*데이터|데이터.*이전.*삭제|산출물|다른\s*부서.*문서/i,
  ],
  security: [
    /개인정보|가명정보|재식별|보안|접근\s*(?:권한|등급|통제)|권한|최소권한|감사로그/i,
    /레드팀|프롬프트\s*인젝션|내부\s*IP|외부\s*LLM.*분석|기밀문서|보안\s*패치|반출/i,
    /감사\s*가능/i,
  ],
  legal: [
    /법적\s*책임|최종\s*책임|외주계약|위탁|재위탁|처리\s*근거|이의제기/i,
    /계약|저작권|이용조건|행정처분|인간\s*검토|삭제\s*기준|목적\s*제한|담당자\s*승인/i,
    /별도\s*용역|용역\s*발주|종료\s*조건|데이터\s*이전/i,
  ],
  policy: [
    /편향|설명가능|이의제기|정책\s*분석|영향평가|AI\s*윤리|윤리\s*영향|차별|소외/i,
    /공공성|행정처분|인간\s*검토|권리|대국민|고위험|기관\s*간|전국\s*기관/i,
    /민원\s*챗봇|담당자\s*이관/i,
    /공공데이터.*공동|공동\s*활용.*책임/i,
  ],
  finance: [
    /예산|비용|총소유비용|TCO|운영비|구매|타당성|사용량/i,
  ],
  procurement: [
    /본사업\s*발주|발주|입찰|조달|디지털서비스|별도\s*용역|제안요청서|사업자|수의계약/i,
    /공급자\s*변경|계약\s*종료|데이터.*이전/i,
  ],
  operations: [
    /운영\s*전환|SLA|응답시간|가용성|장애|복구|모니터링|검수|모델\s*업데이트/i,
    /대체\s*절차|담당자\s*이관|사용량|매일\s*추가|최신성|감사\s*가능|감사로그|장애\s*로그/i,
    /유지보수|성과지표|정확성|평가\s*기준|승인\s*절차|보안\s*패치|전국\s*기관/i,
    /운영\s*(?:관점|방안|정책|절차)/i,
  ],
};

type RoutingEntityRule = {
  id: string;
  owners: AgentId[];
  pattern: RegExp;
};

/** 개인정보처럼 정책 강제가 필요한 값과 일반 업무 개체를 분리해 설명 가능한 점수 신호로 사용한다. */
const routingEntityRules: RoutingEntityRule[] = [
  { id: "personal-identifier", owners: ["security", "legal"], pattern: /주민등록|전화번호|휴대전화|이메일|개인정보|가명정보|민감정보/i },
  { id: "security-control", owners: ["security"], pattern: /접근권한|접근통제|최소권한|감사로그|암호화|기밀|프롬프트\s*인젝션/i },
  { id: "legal-obligation", owners: ["legal"], pattern: /법적|책임|계약|위탁|재위탁|저작권|이용조건|목적\s*제한/i },
  { id: "procurement-action", owners: ["procurement"], pattern: /조달|발주|입찰|수의계약|제안요청서|사업자|공급자/i },
  { id: "financial-value", owners: ["finance"], pattern: /예산|비용|단가|총소유비용|TCO|타당성|사용량/i },
  { id: "service-operation", owners: ["operations"], pattern: /운영|SLA|장애|복구|가용성|모니터링|검수|유지보수/i },
  { id: "data-asset", owners: ["data"], pattern: /학습데이터|데이터셋|메타데이터|출처|라벨|갱신|폐기|공공데이터/i },
  { id: "technical-system", owners: ["tech"], pattern: /AI|LLM|RAG|모델|아키텍처|기술\s*구성|성능|응답시간|정확도/i },
  { id: "public-impact", owners: ["policy"], pattern: /정책|윤리|편향|설명가능|영향평가|공공성|차별|인권|소외/i },
];

const semanticStopWords = new Set([
  "검토", "검토해", "주세요", "정해", "정의해", "제시해", "설계해", "작성해",
  "위한", "위해", "관련", "대한", "포함", "방안", "항목", "기준", "경우", "같이",
  "어떤", "방식", "하려는", "때", "에서", "으로", "그리고", "또는",
]);

const hybridWeights = {
  profileSimilarity: 0.2,
  keywordEntity: 0.2,
  evidenceReadiness: 0.12,
  missRisk: 0.08,
  costEfficiency: 0.04,
  domainSignal: 0.36,
} as const;

const hybridDecisionThreshold = 0.3;
const hybridMarginThreshold = 0.025;

function normalized(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

function tokenize(text: string) {
  return normalized(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function rounded(value: number) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function semanticToken(token: string) {
  const stripped = token.replace(/(?:에게|한테|까지|부터|처럼|보다|에서|으로|에는|에서는|으로는|은|는|이|가|을|를|의|에|와|과|도|만)$/u, "");
  return stripped.length > 1 ? stripped : token;
}

function semanticTokens(text: string) {
  return unique(tokenize(text).map(semanticToken).filter((token) => !semanticStopWords.has(token)));
}

function hasNegatedPrivacyScope(query: string) {
  return /개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/i.test(query);
}

/** 부정 범위의 개인정보 단어가 보안·법무의 양성 신호로 다시 사용되지 않게 한다. */
function routingSemanticText(query: string) {
  return query.replace(/개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/gi, "공개정보");
}

function characterBigrams(value: string) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

function tokenAffinity(left: string, right: string) {
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  const leftPairs = characterBigrams(left);
  const rightPairs = characterBigrams(right);
  if (!leftPairs.length || !rightPairs.length) return 0;
  const remaining = [...rightPairs];
  let overlap = 0;
  for (const pair of leftPairs) {
    const index = remaining.indexOf(pair);
    if (index >= 0) {
      overlap += 1;
      remaining.splice(index, 1);
    }
  }
  return (2 * overlap) / (leftPairs.length + rightPairs.length);
}

/** 요청의 모든 의미 토큰을 Agent 프로필에 대조한다. 단일 최고 단어만으로 주관기관을 고르지 않는다. */
function profileSimilarity(query: string, agentId: AgentId) {
  const profile = agentProfiles[agentId];
  const profileDocument = [
    agentId,
    profile.name,
    profile.shortName,
    profile.responsibility,
    ...profile.keywords,
    ...roleConcepts[agentId].flatMap((concept) => [concept.label, ...concept.aliases]),
  ].join(" ");
  const queryTokens = semanticTokens(query);
  const profileTokens = semanticTokens(profileDocument);
  if (!queryTokens.length || !profileTokens.length) return 0;
  const affinities = queryTokens.map((queryToken) =>
    Math.max(...profileTokens.map((profileToken) => tokenAffinity(queryToken, profileToken))),
  );
  const averageAffinity = affinities.reduce((sum, value) => sum + value, 0) / affinities.length;
  const meaningfulCoverage = affinities.filter((value) => value >= 0.72).length / affinities.length;
  return rounded(averageAffinity * 0.7 + meaningfulCoverage * 0.3);
}

function conceptMatches(agentId: AgentId, query: string) {
  const haystack = normalized(query);
  return roleConcepts[agentId]
    .filter((concept) => [concept.label, ...concept.aliases].some((alias) => haystack.includes(normalized(alias))))
    .map((concept) => concept.id);
}

function primaryHardGate(query: string, securityLevel: RoutingSecurityLevel) {
  const reasons: string[] = [];
  let forcedAgent: AgentId | null = null;
  if (securityLevel === "personal") {
    forcedAgent = "security";
    reasons.push("personal-data-security-owner");
  } else if (securityLevel === "confidential") {
    forcedAgent = "security";
    reasons.push("confidential-boundary-security-owner");
  } else if (/발주|입찰|조달|규격서|사업자|수의계약/i.test(query)) {
    forcedAgent = "procurement";
    reasons.push("explicit-procurement-owner");
  }
  return { applied: forcedAgent !== null, forcedAgent, reasons };
}

function buildPrimaryRoutingScores(
  query: string,
  securityLevel: RoutingSecurityLevel,
  purpose: RoutingPurpose,
) {
  const scoringQuery = routingSemanticText(query);
  const normalizedQuery = normalized(scoringQuery);
  const detectedEntities = routingEntityRules.filter((rule) => rule.pattern.test(scoringQuery));
  const semanticLexicalScores = Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    agentProfiles[agentId].keywords.filter((keyword) => normalizedQuery.includes(normalized(keyword))).length,
  ])) as Record<AgentId, number>;
  const maximumLexical = Math.max(1, ...Object.values(semanticLexicalScores));
  const scored = agentIds.map((agentId) => {
    const matchedTerms = unique(agentProfiles[agentId].keywords.filter((keyword) =>
      normalizedQuery.includes(normalized(keyword)),
    ));
    const matchedEntities = detectedEntities.filter((rule) => rule.owners.includes(agentId)).map((rule) => rule.id);
    const matchedConceptIds = conceptMatches(agentId, scoringQuery);
    const domainMatches = domainRoleSignals[agentId].filter((pattern) => pattern.test(scoringQuery)).length;
    const missCost = (criticalMissCost[agentId] ?? 1) *
      (purpose === "decision" ? 1.15 : 1) *
      ((securityLevel === "personal" || securityLevel === "confidential") && (agentId === "security" || agentId === "legal") ? 1.3 : 1);
    const components = {
      profileSimilarity: profileSimilarity(scoringQuery, agentId),
      keywordEntity: rounded(
        (semanticLexicalScores[agentId] / maximumLexical) * 0.6 +
        Math.min(1, matchedEntities.length / 2) * 0.4,
      ),
      evidenceReadiness: rounded(
        ((agentProfiles[agentId].ragAgents as readonly AgentId[]).includes(agentId) ? 0.35 : 0) +
        Math.min(1, agentProfiles[agentId].ragAgents.length / 3) * 0.25 +
        (matchedConceptIds.length / roleConcepts[agentId].length) * 0.4,
      ),
      missRisk: rounded(missCost / 1.8),
      costEfficiency: rounded(1 / (1 + Math.max(0, agentProfiles[agentId].ragAgents.length - 1) * 0.18)),
      domainSignal: rounded(domainMatches ? 0.6 + Math.min(0.4, (domainMatches - 1) * 0.2) : 0),
    };
    const totalScore = rounded(Object.entries(hybridWeights).reduce(
      (sum, [component, weight]) => sum + components[component as keyof typeof components] * weight,
      0,
    ));
    return { agentId, rank: 0, totalScore, components, matchedTerms, matchedEntities, matchedConceptIds };
  }).sort((left, right) => right.totalScore - left.totalScore || agentIds.indexOf(left.agentId) - agentIds.indexOf(right.agentId));
  return scored.map((score, index): PrimaryRoutingScore => ({ ...score, rank: index + 1 }));
}

export function inferRoutingSecurityLevel(query: string, filteredFields: string[] = []): RoutingSecurityLevel {
  if (filteredFields.length || /주민등록|전화번호|휴대전화|이메일|직접식별|개인 식별/i.test(query)) return "personal";
  if (/기밀|비밀|민감|관리계정|내부\s*ip|권한경계/i.test(query)) return "confidential";
  if (/내부|민원|고객|직원|계약|개인정보/i.test(query)) return "internal";
  return "public";
}

function inferPurpose(query: string): RoutingPurpose {
  if (/감사|점검|준수|컴플라이언스|검수/i.test(query)) return "audit";
  if (/결정|승인|발주|도입|계약|선정/i.test(query)) return "decision";
  return "advice";
}

function relevantRoles(query: string, lexicalScores: Record<AgentId, number>) {
  const scoringQuery = routingSemanticText(query);
  const roles = new Set<AgentId>(agentIds.filter((id) =>
    domainRoleSignals[id].some((pattern) => pattern.test(scoringQuery)),
  ));
  const privacyNegated = hasNegatedPrivacyScope(query);
  if (!privacyNegated && /개인정보|주민등록|가명정보|민감정보|직접식별/i.test(query)) {
    roles.add("security");
    roles.add("legal");
  }
  if (/발주|입찰|조달|규격서|사업자|수의계약/i.test(query)) {
    roles.add("procurement");
    roles.add("finance");
  }
  if (/SLA|장애|가용성|모니터링|운영\s*전환/i.test(query)) roles.add("operations");
  if (!roles.size) {
    const fallbackScores = privacyNegated
      ? Object.fromEntries(agentIds.map((id) => [
          id,
          agentProfiles[id].keywords.filter((keyword) =>
            normalized(scoringQuery).includes(normalized(keyword)),
          ).length,
        ])) as Record<AgentId, number>
      : lexicalScores;
    const fallback = [...agentIds].sort((left, right) => fallbackScores[right] - fallbackScores[left])[0];
    roles.add(fallback ?? "tech");
  }
  return [...roles];
}

function hardRequiredRoles(
  query: string,
  securityLevel: RoutingSecurityLevel,
  primaryAgent: AgentId,
) {
  const required = new Set<AgentId>([primaryAgent]);
  const privacyNegated = hasNegatedPrivacyScope(query);
  if (securityLevel === "personal" || (!privacyNegated && /개인정보|주민등록|가명정보|민감정보|직접식별/i.test(query))) {
    required.add("security");
    required.add("legal");
  } else if (securityLevel === "confidential") {
    required.add("security");
  }
  if (/발주|입찰|조달|규격서|사업자|수의계약/i.test(query)) {
    required.add("procurement");
    required.add("finance");
  }
  return [...required];
}

function choosePrimaryLegacy(
  query: string,
  candidates: AgentId[],
  lexicalScores: Record<AgentId, number>,
  securityLevel: RoutingSecurityLevel,
) {
  if (securityLevel === "personal" || securityLevel === "confidential") return "security" as const;
  if (/발주|입찰|조달|규격서|사업자|수의계약/i.test(query)) return "procurement" as const;
  const semanticPriority: AgentId[] = [
    "security",
    "legal",
    "policy",
    "data",
    "finance",
    "operations",
    "tech",
    "procurement",
  ];
  return [...candidates].sort((left, right) => {
    const leftDomainSignals = domainRoleSignals[left].filter((pattern) => pattern.test(query)).length;
    const rightDomainSignals = domainRoleSignals[right].filter((pattern) => pattern.test(query)).length;
    if (rightDomainSignals !== leftDomainSignals) return rightDomainSignals - leftDomainSignals;
    const scoreDifference = lexicalScores[right] - lexicalScores[left];
    if (scoreDifference) return scoreDifference;
    return semanticPriority.indexOf(left) - semanticPriority.indexOf(right);
  })[0] ?? "tech";
}

function choosePrimaryHybrid(
  query: string,
  candidates: AgentId[],
  lexicalScores: Record<AgentId, number>,
  securityLevel: RoutingSecurityLevel,
  purpose: RoutingPurpose,
) {
  const rankedCandidates = buildPrimaryRoutingScores(query, securityLevel, purpose);
  const hardGate = primaryHardGate(query, securityLevel);
  const first = rankedCandidates[0];
  const second = rankedCandidates[1];
  const top1Top2Margin = rounded(Math.max(0, (first?.totalScore ?? 0) - (second?.totalScore ?? 0)));
  const lowScore = (first?.totalScore ?? 0) < hybridDecisionThreshold;
  const narrowMargin = top1Top2Margin < hybridMarginThreshold;
  const fallbackUsed = !hardGate.applied && (lowScore || narrowMargin);
  const fallbackReason = !fallbackUsed
    ? null
    : lowScore
      ? "hybrid-score-below-threshold"
      : "hybrid-score-margin-too-narrow";
  const primaryAgent = hardGate.forcedAgent ?? (
    fallbackUsed
      ? choosePrimaryLegacy(query, candidates, lexicalScores, securityLevel)
      : first?.agentId ?? "tech"
  );
  const selectedScore = rankedCandidates.find((candidate) => candidate.agentId === primaryAgent)?.totalScore ?? 0;
  const confidence = hardGate.applied
    ? 0.99
    : rounded((selectedScore * 0.7 + Math.min(1, top1Top2Margin / 0.15) * 0.3) * (fallbackUsed ? 0.85 : 1));
  const reviewReasons = [
    ...(lowScore ? [`hybrid-score-below-${hybridDecisionThreshold.toFixed(3)}`] : []),
    ...(narrowMargin ? [`top1-top2-margin-below-${hybridMarginThreshold.toFixed(3)}`] : []),
    ...(!hardGate.applied && !(first?.matchedTerms.length || first?.matchedEntities.length || first?.components.domainSignal)
      ? ["no-domain-keyword-or-entity-signal"]
      : []),
  ];
  const primarySelection: PrimaryRoutingSelection = {
    algorithm: "hybrid-profile-v1",
    hardGate,
    rankedCandidates,
    confidence,
    top1Top2Margin,
    decisionThreshold: hybridDecisionThreshold,
    fallbackUsed,
    fallbackReason,
    reviewReasons,
  };
  return { primaryAgent, primarySelection };
}

function requiredConceptsForRoles(roles: AgentId[]) {
  return unique(roles.flatMap((role) => roleConcepts[role]).map((concept) => concept.id))
    .map((id) => roles.flatMap((role) => roleConcepts[role]).find((concept) => concept.id === id)!)
    .filter(Boolean);
}

export function measureRequiredConceptCoverage(requiredConcepts: RequiredConcept[], text: string) {
  if (!requiredConcepts.length) {
    return { coverage: null, coveredConceptIds: [] as string[], missingConceptIds: [] as string[] };
  }
  const haystack = normalized(text);
  const haystackTokens = new Set(tokenize(text));
  const coveredConceptIds = requiredConcepts
    .filter((concept) => [concept.label, ...concept.aliases].some((alias) => {
      const value = normalized(alias);
      if (haystack.includes(value)) return true;
      const aliasTokens = tokenize(alias);
      return aliasTokens.length > 0 && aliasTokens.every((token) =>
        [...haystackTokens].some((candidate) => candidate.includes(token) || token.includes(candidate)),
      );
    }))
    .map((concept) => concept.id);
  const covered = new Set(coveredConceptIds);
  return {
    coverage: Number((coveredConceptIds.length / requiredConcepts.length).toFixed(3)),
    coveredConceptIds,
    missingConceptIds: requiredConcepts.filter((concept) => !covered.has(concept.id)).map((concept) => concept.id),
  };
}

export function routeWithBoundaryConstraints(input: {
  query: string;
  lexicalScores: Record<AgentId, number>;
  filteredFields?: string[];
}): BoundaryRoutingDecision {
  const securityLevel = inferRoutingSecurityLevel(input.query, input.filteredFields);
  const purpose = inferPurpose(input.query);
  const candidateAgents = relevantRoles(input.query, input.lexicalScores);
  const { primaryAgent, primarySelection } = choosePrimaryHybrid(
    input.query,
    candidateAgents,
    input.lexicalScores,
    securityLevel,
    purpose,
  );
  if (!candidateAgents.includes(primaryAgent)) candidateAgents.unshift(primaryAgent);
  const required = hardRequiredRoles(input.query, securityLevel, primaryAgent);
  const conceptRoles = unique([...candidateAgents, ...required]);
  const requiredConcepts = requiredConceptsForRoles(conceptRoles);
  const normalizedQuery = normalized(routingSemanticText(input.query));
  const estimates = agentIds.map((id): AgentRoutingEstimate => {
    const signals = agentProfiles[id].keywords.filter((keyword) => normalizedQuery.includes(normalized(keyword)));
    const coupled = required.includes(id);
    const probability = Math.min(0.99, 0.08 + signals.length * 0.17 + (coupled ? 0.28 : 0));
    const missCost = (criticalMissCost[id] ?? 1) *
      (purpose === "decision" ? 1.15 : 1) *
      ((securityLevel === "personal" || securityLevel === "confidential") && (id === "security" || id === "legal") ? 1.3 : 1);
    const callCost = 0.19;
    const byteCost = 0.035;
    const latencyCost = 0.025;
    return {
      id,
      probability: Number(probability.toFixed(3)),
      missCost: Number(missCost.toFixed(3)),
      callCost,
      byteCost,
      latencyCost,
      utility: Number((probability * missCost - callCost - byteCost - latencyCost).toFixed(3)),
      signals,
    };
  });
  const selected = unique([primaryAgent, ...required.filter((id) => id !== primaryAgent)]);
  const selectedEstimates = estimates.filter((estimate) => selected.includes(estimate.id));
  const candidateProbability = estimates
    .filter((estimate) => candidateAgents.includes(estimate.id))
    .reduce((sum, estimate) => sum + estimate.probability, 0);
  const selectedProbability = selectedEstimates.reduce((sum, estimate) => sum + estimate.probability, 0);
  const predictedCoverage = candidateProbability
    ? Number(Math.min(1, selectedProbability / candidateProbability).toFixed(3))
    : 0;
  const rationale = [
    `${agentProfiles[primaryAgent].shortName} Agent를 1차 처리 담당으로 선택했습니다.`,
    primarySelection.hardGate.applied
      ? `경계 정책(${primarySelection.hardGate.reasons.join("·")})이 의미 점수보다 우선 적용되었습니다.`
      : `프로필·키워드/개체·근거 준비도·누락 위험·비용 점수를 종합했습니다(신뢰도 ${Math.round(primarySelection.confidence * 100)}%, 1·2위 차이 ${primarySelection.top1Top2Margin.toFixed(3)}).`,
    primarySelection.fallbackUsed
      ? `점수 불확실성(${primarySelection.fallbackReason}) 때문에 기존 업무 신호 규칙으로 보강했습니다.`
      : "하이브리드 점수가 결정 임계값과 후보 간격 조건을 충족했습니다.",
    required.length > 1
      ? `${required.filter((id) => id !== primaryAgent).map((id) => agentProfiles[id].shortName).join("·")} 영역은 경계 정책상 필수 검토입니다.`
      : "현재 분류에서는 추가 필수 검토 역할이 없습니다.",
    requiredConcepts.length
      ? `${requiredConcepts.length}개 필수 개념의 충족 여부를 Edge 응답 후 다시 검사합니다.`
      : "필수 개념을 도출하지 못해 사람 검토가 필요합니다.",
  ];
  return {
    version: "2",
    strategy: "boundary-constrained",
    securityLevel,
    purpose,
    primaryAgent,
    candidateAgents,
    required,
    selected,
    supportingAgents: selected.filter((id) => id !== primaryAgent),
    requiredConcepts,
    estimates,
    primarySelection,
    predictedCoverage,
    objectiveCost: Number(selectedEstimates.reduce(
      (sum, estimate) => sum + estimate.callCost + estimate.byteCost + estimate.latencyCost,
      0,
    ).toFixed(3)),
    adaptiveAdditions: [],
    humanReviewRequired: requiredConcepts.length === 0 || (
      primarySelection.fallbackUsed &&
      primarySelection.reviewReasons.includes("no-domain-keyword-or-entity-signal")
    ),
    rationale,
  };
}

export function planAdaptiveAdditions(
  routing: BoundaryRoutingDecision,
  observed: Partial<Record<AgentId, ObservedAgentOutput>>,
): AdaptiveRoutingDecision {
  const outputs = Object.entries(observed) as [AgentId, ObservedAgentOutput][];
  const denied = outputs.some(([, output]) => output.status === "denied" || output.policyOutcome === "deny");
  const coveredConceptIds = [...new Set(outputs.flatMap(([, output]) =>
    output.evidenceCoverage?.coveredConceptIds ?? [],
  ))];
  const covered = new Set(coveredConceptIds);
  const missingConceptIds = routing.requiredConcepts
    .filter((concept) => !covered.has(concept.id))
    .map((concept) => concept.id);
  const coverage = routing.requiredConcepts.length
    ? Number((coveredConceptIds.length / routing.requiredConcepts.length).toFixed(3))
    : null;
  const missing = new Set(missingConceptIds);
  if (denied) {
    return {
      additions: [],
      coveredConceptIds,
      missingConceptIds,
      coverage,
      humanReviewRequired: true,
      rationale: "Edge 정책이 요청을 거부했습니다. 중앙 Router는 다른 Agent로 우회하지 않고 사람 검토로 전환합니다.",
    };
  }
  const additions = unique([
    ...routing.required.filter((id) => id !== routing.primaryAgent && !observed[id]),
    ...routing.requiredConcepts
      .filter((concept) => missing.has(concept.id) && !observed[concept.owner])
      .map((concept) => concept.owner),
  ]).filter((id) => routing.candidateAgents.includes(id) || routing.required.includes(id));
  const insufficient = outputs.some(([, output]) => output.status === "insufficient-evidence");
  const humanReviewRequired = routing.humanReviewRequired ||
    (coverage === null && additions.length === 0) ||
    (coverage !== null && coverage < 1 && additions.length === 0) ||
    (insufficient && additions.length === 0);
  return {
    additions,
    coveredConceptIds,
    missingConceptIds,
    coverage,
    humanReviewRequired,
    rationale: additions.length
        ? `미충족 필수 개념을 담당하는 ${additions.map((id) => agentProfiles[id].shortName).join("·")} Agent를 추가합니다.`
        : coverage === 1
          ? "1차 응답이 모든 필수 개념을 충족해 추가 Agent 호출을 생략합니다."
          : "추가로 호출할 수 있는 적격 Agent가 없어 사람 검토가 필요합니다.",
  };
}

export function conceptsForAgent(routing: BoundaryRoutingDecision, agentId: AgentId) {
  return routing.requiredConcepts.filter((concept) => concept.owner === agentId);
}

export function conceptIdsForAgent(routing: BoundaryRoutingDecision, agentId: AgentId) {
  return conceptsForAgent(routing, agentId).map((concept) => concept.id);
}

export function isKnownConceptForAgent(conceptId: string, agentId: AgentId) {
  return conceptCatalog.get(conceptId)?.owner === agentId;
}

export function resolveConceptsForAgent(conceptIds: string[], agentId: AgentId) {
  return conceptIds.map((conceptId) => conceptCatalog.get(conceptId))
    .filter((concept): concept is RequiredConcept => concept?.owner === agentId);
}
