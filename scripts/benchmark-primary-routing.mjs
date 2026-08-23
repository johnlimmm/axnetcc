import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const datasetPath = path.join(repositoryRoot, "data", "evaluation", "ax-golden-set-40.jsonl");
const currentRouterPath = path.join(repositoryRoot, "lib", "boundary-router.ts");
const runtimeBundlePath = path.join(repositoryRoot, "dist", "server", "index.js");
const outputDirectory = path.join(repositoryRoot, "reports", "primary-routing-benchmark");

const agentOrder = [
  "tech",
  "data",
  "security",
  "legal",
  "policy",
  "finance",
  "procurement",
  "operations",
];

const agentProfiles = {
  tech: {
    name: "기술검토 Agent",
    shortName: "기술",
    responsibility: "디지털전략팀 기술검토 책임",
    keywords: ["AI", "LLM", "기술", "시스템", "서비스", "클라우드", "구축", "운영", "성능", "응답시간", "품질", "RAG", "모델"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["tech"],
  },
  data: {
    name: "데이터거버넌스 Agent",
    shortName: "데이터",
    responsibility: "데이터 관리부서 품질·수명주기·메타데이터 검토",
    keywords: ["데이터셋", "데이터 품질", "학습데이터", "수집", "정제", "라벨링", "메타데이터", "갱신", "가명정보", "공공데이터"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["data", "tech", "legal"],
  },
  security: {
    name: "보안 Agent",
    shortName: "보안",
    responsibility: "정보보호팀 보안성 검토",
    keywords: ["보안", "개인정보", "민감", "데이터", "접근", "민원", "내부", "클라우드", "반출", "권한", "기밀"],
    allowedClasses: ["public", "internal", "confidential"],
    ragAgents: ["security"],
  },
  legal: {
    name: "법무 Agent",
    shortName: "법무",
    responsibility: "법무팀 규정·계약 검토",
    keywords: ["법", "책임", "계약", "규정", "민원", "개인정보", "외주", "위탁", "조항"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["legal"],
  },
  policy: {
    name: "정책·윤리 Agent",
    shortName: "정책",
    responsibility: "AI 정책담당 공공성·투명성·영향평가 검토",
    keywords: ["정책", "윤리", "공정성", "편향", "투명성", "설명가능", "영향평가", "공공성", "책임성", "인권"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["policy", "legal", "tech"],
  },
  finance: {
    name: "재무 Agent",
    shortName: "재무",
    responsibility: "재무·구매팀 예산 타당성 검토",
    keywords: ["예산", "비용", "조달", "타당성", "계약", "운영비", "TCO", "구매"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["finance"],
  },
  procurement: {
    name: "조달·계약 Agent",
    shortName: "조달",
    responsibility: "구매·계약부서 발주·경쟁성·사업자 종속 검토",
    keywords: ["조달", "발주", "입찰", "제안요청서", "규격서", "사업자", "수의계약", "카탈로그", "디지털서비스", "계약"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["procurement", "finance", "legal"],
  },
  operations: {
    name: "운영·품질 Agent",
    shortName: "운영",
    responsibility: "서비스 운영부서 SLA·장애·품질·모니터링 검토",
    keywords: ["운영", "SLA", "장애", "모니터링", "응답시간", "가용성", "품질", "평가", "검수", "유지보수", "성능", "대응", "절차"],
    allowedClasses: ["public", "internal"],
    ragAgents: ["operations", "tech", "security"],
  },
};

const roleConcepts = {
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

const criticalRoles = new Set(["security", "legal", "procurement", "finance"]);
const criticalMissCost = { security: 1.55, legal: 1.45, operations: 1.2, data: 1.15 };

const domainRoleSignals = {
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
  finance: [/예산|비용|총소유비용|TCO|운영비|구매|타당성|사용량/i],
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

const routingEntityRules = [
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
};
const hybridDecisionThreshold = 0.3;
const hybridMarginThreshold = 0.025;

let currentRuntimeRecords = new Map();

function normalize(text) {
  return text.normalize("NFKC").toLowerCase();
}

function sanitizeBenchmarkQuery(text) {
  const patterns = [
    ["주민등록번호", /\b\d{6}-?[1-4]\d{6}\b/g],
    ["휴대전화", /\b01[016789]-?\d{3,4}-?\d{4}\b/g],
    ["이메일", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ["내부 IP", /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g],
  ];
  const filteredFields = [];
  let sanitized = text.trim();
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (!pattern.test(sanitized)) continue;
    filteredFields.push(label);
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, `[${label} 제거]`);
  }
  return { sanitized, filteredFields };
}

function tokenize(text) {
  return normalize(text).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((token) => token.length > 1);
}

function unique(values) {
  return [...new Set(values)];
}

function rounded(value) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function semanticToken(token) {
  const stripped = token.replace(/(?:에게|한테|까지|부터|처럼|보다|에서|으로|에는|에서는|으로는|은|는|이|가|을|를|의|에|와|과|도|만)$/u, "");
  return stripped.length > 1 ? stripped : token;
}

function semanticTokens(text) {
  return unique(tokenize(text).map(semanticToken).filter((token) => !semanticStopWords.has(token)));
}

function hasNegatedPrivacyScope(query) {
  return /개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/i.test(query);
}

function routingSemanticText(query) {
  return query.replace(/개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/gi, "공개정보");
}

function characterBigrams(value) {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return compact ? [compact] : [];
  return Array.from({ length: compact.length - 1 }, (_, index) => compact.slice(index, index + 2));
}

function tokenAffinity(left, right) {
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

function profileSimilarity(query, agentId) {
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

function lexicalScores(query) {
  const normalized = normalize(query);
  return Object.fromEntries(agentOrder.map((agentId) => [
    agentId,
    agentProfiles[agentId].keywords.reduce(
      (score, keyword) => score + (normalized.includes(normalize(keyword)) ? 1 : 0),
      0,
    ),
  ]));
}

function rankedByLexicalScore(scores) {
  return [...agentOrder].sort((left, right) =>
    scores[right] - scores[left] || agentOrder.indexOf(left) - agentOrder.indexOf(right),
  );
}

function routeKeywordTopOne(query) {
  const scores = lexicalScores(query);
  const primaryAgent = rankedByLexicalScore(scores)[0] ?? "tech";
  return { primaryAgent, selected: [primaryAgent] };
}

function routeCurrentKeywordFanout(query) {
  const scores = lexicalScores(query);
  const selected = agentOrder.filter((agentId) => scores[agentId] > 0);
  if (!selected.length) selected.push("tech");
  const primaryAgent = rankedByLexicalScore(scores).find((agentId) => selected.includes(agentId)) ?? selected[0];
  return { primaryAgent, selected };
}

function inferLegacyPolicy(query) {
  const classification = /주민등록|민감|기밀|비밀|내부\s*ip|관리계정/i.test(query)
    ? "confidential"
    : /내부|민원|고객|직원|계약/i.test(query)
      ? "internal"
      : "public";
  const purpose = /감사|평가|준수|컴플라이언스/i.test(query)
    ? "audit"
    : /결정|승인|발주|도입|계약/i.test(query)
      ? "decision"
      : "advice";
  return {
    classification,
    purpose,
    minimumCoverage: purpose === "decision" || classification === "confidential" ? 0.92 : 0.84,
    maxAgents: purpose === "audit" ? 7 : 6,
  };
}

function routeV2Boundary(query) {
  const scores = lexicalScores(query);
  const policy = inferLegacyPolicy(query);
  const required = new Set();
  const privacyNegated = /개인정보(?:가)?\s*(?:없는|없이|미포함)|비식별\s*공개/i.test(query);
  for (const agentId of agentOrder) {
    if (scores[agentId] > 0 && !(privacyNegated && (agentId === "security" || agentId === "legal"))) required.add(agentId);
  }
  const couplings = [
    { pattern: /민원|개인정보|주민등록|가명|민감/i, agents: ["security", "legal"] },
    { pattern: /발주|입찰|조달|규격서|사업자/i, agents: ["procurement", "finance"] },
    { pattern: /ai|llm|rag|생성형|모델/i, agents: ["tech"] },
    { pattern: /운영|sla|장애|가용성|응답시간|품질/i, agents: ["operations"] },
  ];
  for (const coupling of couplings) {
    if (privacyNegated && coupling.agents.includes("security")) continue;
    if (coupling.pattern.test(query)) coupling.agents.forEach((agentId) => required.add(agentId));
  }
  if (!required.size) required.add("tech");

  const normalizedQuery = normalize(query);
  const estimates = agentOrder.map((agentId) => {
    const signals = agentProfiles[agentId].keywords.filter((keyword) => normalizedQuery.includes(normalize(keyword)));
    const coupled = required.has(agentId);
    const probability = Math.min(0.99, 0.08 + signals.length * 0.19 + (coupled ? 0.24 : 0));
    const missCost = (criticalMissCost[agentId] ?? 1) *
      (policy.purpose === "decision" ? 1.15 : 1) *
      (policy.classification === "confidential" && (agentId === "security" || agentId === "legal") ? 1.25 : 1);
    const allowed = agentProfiles[agentId].allowedClasses.includes(policy.classification) ||
      (policy.classification === "confidential" && agentProfiles[agentId].allowedClasses.includes("internal"));
    return { id: agentId, probability, utility: probability * missCost - 0.19 - 0.035 - 0.025, allowed };
  });
  const allowedRequired = estimates
    .filter((estimate) => estimate.allowed && required.has(estimate.id))
    .sort((left, right) => right.utility - left.utility || agentOrder.indexOf(left.id) - agentOrder.indexOf(right.id));
  const totalProbability = allowedRequired.reduce((sum, estimate) => sum + estimate.probability, 0);
  const selected = [];
  let coveredProbability = 0;
  for (const estimate of allowedRequired) {
    if (selected.length >= policy.maxAgents) break;
    if (estimate.utility > 0 || coveredProbability / Math.max(totalProbability, 0.001) < policy.minimumCoverage) {
      selected.push(estimate.id);
      coveredProbability += estimate.probability;
    }
  }
  if (!selected.length) selected.push("tech");
  return { primaryAgent: selected[0], selected };
}

function conceptMatches(agentId, query) {
  const haystack = normalize(query);
  return roleConcepts[agentId]
    .filter((concept) => [concept.label, ...concept.aliases].some((alias) => haystack.includes(normalize(alias))))
    .map((concept) => concept.id);
}

function inferRoutingSecurityLevel(query, filteredFields = []) {
  if (filteredFields.length || /주민등록|전화번호|휴대전화|이메일|직접식별|개인 식별/i.test(query)) return "personal";
  if (/기밀|비밀|민감|관리계정|내부\s*ip|권한경계/i.test(query)) return "confidential";
  if (/내부|민원|고객|직원|계약|개인정보/i.test(query)) return "internal";
  return "public";
}

function inferPurpose(query) {
  if (/감사|점검|준수|컴플라이언스|검수/i.test(query)) return "audit";
  if (/결정|승인|발주|도입|계약|선정/i.test(query)) return "decision";
  return "advice";
}

function relevantRoles(query, scores) {
  const scoringQuery = routingSemanticText(query);
  const roles = new Set(agentOrder.filter((agentId) => domainRoleSignals[agentId].some((pattern) => pattern.test(scoringQuery))));
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
    const fallbackScores = privacyNegated ? lexicalScores(scoringQuery) : scores;
    roles.add(rankedByLexicalScore(fallbackScores)[0] ?? "tech");
  }
  return [...roles];
}

function hardRequiredRoles(query, securityLevel, primaryAgent) {
  const required = new Set([primaryAgent]);
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

function primaryHardGate(query, securityLevel) {
  const reasons = [];
  let forcedAgent = null;
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

function buildPrimaryRoutingScores(query, securityLevel, purpose) {
  const scoringQuery = routingSemanticText(query);
  const normalizedQuery = normalize(scoringQuery);
  const detectedEntities = routingEntityRules.filter((rule) => rule.pattern.test(scoringQuery));
  const semanticLexicalScores = lexicalScores(scoringQuery);
  const maximumLexical = Math.max(1, ...Object.values(semanticLexicalScores));
  return agentOrder.map((agentId) => {
    const matchedTerms = unique(agentProfiles[agentId].keywords.filter((keyword) => normalizedQuery.includes(normalize(keyword))));
    const matchedEntities = detectedEntities.filter((rule) => rule.owners.includes(agentId)).map((rule) => rule.id);
    const matchedConceptIds = conceptMatches(agentId, scoringQuery);
    const domainMatches = domainRoleSignals[agentId].filter((pattern) => pattern.test(scoringQuery)).length;
    const missCost = (criticalMissCost[agentId] ?? 1) *
      (purpose === "decision" ? 1.15 : 1) *
      ((securityLevel === "personal" || securityLevel === "confidential") && (agentId === "security" || agentId === "legal") ? 1.3 : 1);
    const components = {
      profileSimilarity: profileSimilarity(scoringQuery, agentId),
      keywordEntity: rounded((semanticLexicalScores[agentId] / maximumLexical) * 0.6 + Math.min(1, matchedEntities.length / 2) * 0.4),
      evidenceReadiness: rounded(
        (agentProfiles[agentId].ragAgents.includes(agentId) ? 0.35 : 0) +
        Math.min(1, agentProfiles[agentId].ragAgents.length / 3) * 0.25 +
        (matchedConceptIds.length / roleConcepts[agentId].length) * 0.4,
      ),
      missRisk: rounded(missCost / 1.8),
      costEfficiency: rounded(1 / (1 + Math.max(0, agentProfiles[agentId].ragAgents.length - 1) * 0.18)),
      domainSignal: rounded(domainMatches ? 0.6 + Math.min(0.4, (domainMatches - 1) * 0.2) : 0),
    };
    const totalScore = rounded(Object.entries(hybridWeights).reduce(
      (sum, [component, weight]) => sum + components[component] * weight,
      0,
    ));
    return { agentId, rank: 0, totalScore, components, matchedTerms, matchedEntities, matchedConceptIds };
  }).sort((left, right) => right.totalScore - left.totalScore || agentOrder.indexOf(left.agentId) - agentOrder.indexOf(right.agentId))
    .map((score, index) => ({ ...score, rank: index + 1 }));
}

function choosePrimaryLegacy(query, candidates, scores, securityLevel) {
  if (securityLevel === "personal" || securityLevel === "confidential") return "security";
  if (/발주|입찰|조달|규격서|사업자|수의계약/i.test(query)) return "procurement";
  const semanticPriority = ["security", "legal", "policy", "data", "finance", "operations", "tech", "procurement"];
  return [...candidates].sort((left, right) => {
    const domainDifference = domainRoleSignals[right].filter((pattern) => pattern.test(query)).length -
      domainRoleSignals[left].filter((pattern) => pattern.test(query)).length;
    return domainDifference || scores[right] - scores[left] || semanticPriority.indexOf(left) - semanticPriority.indexOf(right);
  })[0] ?? "tech";
}

function choosePrimaryHybrid(query, candidates, scores, securityLevel, purpose) {
  const rankedCandidates = buildPrimaryRoutingScores(query, securityLevel, purpose);
  const hardGate = primaryHardGate(query, securityLevel);
  const first = rankedCandidates[0];
  const second = rankedCandidates[1];
  const top1Top2Margin = rounded(Math.max(0, (first?.totalScore ?? 0) - (second?.totalScore ?? 0)));
  const lowScore = (first?.totalScore ?? 0) < hybridDecisionThreshold;
  const narrowMargin = top1Top2Margin < hybridMarginThreshold;
  const fallbackUsed = !hardGate.applied && (lowScore || narrowMargin);
  const primaryAgent = hardGate.forcedAgent ?? (
    fallbackUsed ? choosePrimaryLegacy(query, candidates, scores, securityLevel) : first?.agentId ?? "tech"
  );
  return {
    primaryAgent,
    primarySelection: {
      algorithm: "hybrid-profile-v1",
      hardGate,
      rankedCandidates,
      top1Top2Margin,
      fallbackUsed,
    },
  };
}

function requiredConceptsForRoles(roles) {
  return unique(roles.flatMap((role) => roleConcepts[role]).map((concept) => concept.id))
    .map((id) => roles.flatMap((role) => roleConcepts[role]).find((concept) => concept.id === id))
    .filter(Boolean);
}

function routeCurrentInitial(query, filteredFields = []) {
  const scores = lexicalScores(query);
  const securityLevel = inferRoutingSecurityLevel(query, filteredFields);
  const purpose = inferPurpose(query);
  const candidateAgents = relevantRoles(query, scores);
  const { primaryAgent, primarySelection } = choosePrimaryHybrid(query, candidateAgents, scores, securityLevel, purpose);
  if (!candidateAgents.includes(primaryAgent)) candidateAgents.unshift(primaryAgent);
  const required = hardRequiredRoles(query, securityLevel, primaryAgent);
  const requiredConcepts = requiredConceptsForRoles(unique([...candidateAgents, ...required]));
  return { primaryAgent, candidateAgents, required, requiredConcepts, primarySelection };
}

function planAdaptiveAdditions(routing, observed) {
  const outputs = Object.entries(observed);
  const denied = outputs.some(([, output]) => output.status === "denied" || output.policyOutcome === "deny");
  if (denied) return { additions: [], missingConceptIds: routing.requiredConcepts.map((concept) => concept.id) };
  const coveredConceptIds = unique(outputs.flatMap(([, output]) => output.evidenceCoverage?.coveredConceptIds ?? []));
  const covered = new Set(coveredConceptIds);
  const missingConceptIds = routing.requiredConcepts.filter((concept) => !covered.has(concept.id)).map((concept) => concept.id);
  const missing = new Set(missingConceptIds);
  const additions = unique([
    ...routing.required.filter((agentId) => agentId !== routing.primaryAgent && !observed[agentId]),
    ...routing.requiredConcepts
      .filter((concept) => missing.has(concept.id) && !observed[concept.owner])
      .map((concept) => concept.owner),
  ]).filter((agentId) => routing.candidateAgents.includes(agentId) || routing.required.includes(agentId));
  return { additions, missingConceptIds };
}

function routeCurrentMirror(query, item) {
  const runtimeRecord = currentRuntimeRecords.get(item.id);
  if (!runtimeRecord) throw new Error(`Missing current-runtime record for ${item.id}`);
  const initial = routeCurrentInitial(
    runtimeRecord.routingQuery,
    runtimeRecord.inputWasFiltered ? ["masked-input"] : [],
  );
  const adaptive = planAdaptiveAdditions(initial, {
    [runtimeRecord.primaryObservationAgent]: runtimeRecord.primaryObservation,
  });
  const selected = [initial.primaryAgent, ...adaptive.additions.filter((agentId) => agentId !== initial.primaryAgent)];
  return {
    primaryAgent: initial.primaryAgent,
    selected,
    candidateAgents: initial.candidateAgents,
    required: initial.required,
    adaptiveAdditions: adaptive.additions.filter((agentId) => !initial.required.includes(agentId)),
    primarySelection: initial.primarySelection,
  };
}

function routeCurrentActual(_query, item) {
  const runtimeRecord = currentRuntimeRecords.get(item.id);
  if (!runtimeRecord) throw new Error(`Missing current-runtime record for ${item.id}`);
  return {
    primaryAgent: runtimeRecord.decision.primaryAgent,
    selected: runtimeRecord.decision.selected,
    orchestrationLatencyMs: runtimeRecord.orchestrationLatencyMs,
  };
}

const methodDefinitions = [
  {
    id: "keyword_top1",
    label: "Keyword top-1",
    description: "Selects only the Agent with the largest exact keyword-overlap count.",
    selectedSetDefinition: "A singleton containing the highest exact substring-keyword score; agentOrder breaks ties and tech is the zero-hit fallback.",
    predictionSource: "standalone deterministic baseline",
    timingScope: "routing function only",
    route: routeKeywordTopOne,
  },
  {
    id: "current_keyword_fanout",
    label: "Keyword fan-out",
    description: "Reproduces the pre-MNC-16 route: call every Agent with at least one keyword hit.",
    selectedSetDefinition: "Every Agent whose exact substring-keyword score is greater than zero; tech is selected only when no Agent has a hit.",
    predictionSource: "standalone deterministic baseline",
    timingScope: "routing function only",
    route: routeCurrentKeywordFanout,
  },
  {
    id: "v2_boundary_heuristic",
    label: "v2 boundary heuristic",
    description: "Standalone reconstruction of teamlead/v2 coverage/cost and coupled-domain routing.",
    selectedSetDefinition: "The ordered subset of keyword/coupling-required Agents that passes v2 class allowance and is retained by its utility/coverage loop, capped by maxAgents; tech is the empty-set fallback.",
    predictionSource: "standalone reconstruction of teamlead/v2",
    timingScope: "routing function only",
    route: routeV2Boundary,
  },
  {
    id: "current_proposed_adaptive_hybrid",
    label: "Proposed adaptive hybrid",
    description: "Current proposed-mode hybrid-profile-v1 primary selection plus post-primary missing-concept additions.",
    selectedSetDefinition: "The actual final result.routerDecision.selected from proposed orchestration: the hybrid-profile-v1 primary, then mandatory reviewers and candidate owners of concepts still uncovered by the primary Edge response.",
    predictionSource: "actual built proposed-mode orchestrator output",
    timingScope: "JS mirror of initial routing plus adaptive policy using precomputed primary coverage",
    route: routeCurrentActual,
    timingRoute: routeCurrentMirror,
  },
];

function setEquals(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function round(value, digits = 1) {
  return Number(value.toFixed(digits));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function evaluateMethod(method, cases) {
  const rows = cases.map((item) => {
    const routingQuery = currentRuntimeRecords.get(item.id)?.routingQuery ?? item.query;
    const prediction = method.route(routingQuery, item);
    const expected = new Set(item.expected_agents);
    const selected = new Set(prediction.selected);
    const truePositive = [...selected].filter((agentId) => expected.has(agentId)).length;
    const falsePositive = [...selected].filter((agentId) => !expected.has(agentId)).length;
    const falseNegative = [...expected].filter((agentId) => !selected.has(agentId)).length;
    const precision = ratio(truePositive, truePositive + falsePositive);
    const recall = ratio(truePositive, truePositive + falseNegative);
    const f1 = ratio(2 * precision * recall, precision + recall);
    const criticalExpected = item.expected_agents.filter((agentId) => criticalRoles.has(agentId));
    const criticalHits = criticalExpected.filter((agentId) => selected.has(agentId));
    return {
      method: method.id,
      id: item.id,
      domain: item.domain,
      difficulty: item.difficulty,
      predictedPrimary: prediction.primaryAgent,
      expectedAgents: item.expected_agents,
      predictedAgents: [...selected],
      truePositive,
      falsePositive,
      falseNegative,
      precision,
      recall,
      f1,
      exactMatch: setEquals(expected, selected),
      primaryCorrect: expected.has(prediction.primaryAgent),
      criticalExpected,
      criticalHits,
      orchestrationLatencyMs: prediction.orchestrationLatencyMs ?? null,
    };
  });

  const criticalExpectedCount = rows.reduce((sum, row) => sum + row.criticalExpected.length, 0);
  const criticalHitCount = rows.reduce((sum, row) => sum + row.criticalHits.length, 0);
  const orchestrationLatencies = rows.map((row) => row.orchestrationLatencyMs).filter(Number.isFinite);
  return {
    rows,
    metrics: {
      macroF1: round(rows.reduce((sum, row) => sum + row.f1, 0) / rows.length * 100),
      exactMatchRate: round(rows.filter((row) => row.exactMatch).length / rows.length * 100),
      criticalRoleRecall: round(ratio(criticalHitCount, criticalExpectedCount) * 100),
      primaryAccuracy: round(rows.filter((row) => row.primaryCorrect).length / rows.length * 100),
      averageFanOut: round(rows.reduce((sum, row) => sum + row.predictedAgents.length, 0) / rows.length, 2),
      orchestrationLatencyMedianMs: orchestrationLatencies.length ? round(median(orchestrationLatencies), 3) : null,
    },
  };
}

function measureDecisionTime(method, cases) {
  const route = method.timingRoute ?? method.route;
  const warmupIterations = 10;
  const measurementIterations = 50;
  const rounds = 5;
  let checksum = 0;
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    for (const item of cases) {
      const routingQuery = currentRuntimeRecords.get(item.id)?.routingQuery ?? item.query;
      checksum += route(routingQuery, item).selected.length;
    }
  }
  const perDecisionMilliseconds = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const startedAt = process.hrtime.bigint();
    for (let iteration = 0; iteration < measurementIterations; iteration += 1) {
      for (const item of cases) {
        const routingQuery = currentRuntimeRecords.get(item.id)?.routingQuery ?? item.query;
        const decision = route(routingQuery, item);
        checksum += decision.selected.length + decision.primaryAgent.length;
      }
    }
    const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    perDecisionMilliseconds.push(elapsedMilliseconds / (measurementIterations * cases.length));
  }
  const sorted = [...perDecisionMilliseconds].sort((left, right) => left - right);
  return {
    meanMs: round(perDecisionMilliseconds.reduce((sum, value) => sum + value, 0) / rounds, 6),
    medianMs: round(sorted[Math.floor(sorted.length / 2)], 6),
    p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1], 6),
    rounds,
    warmupIterations,
    measurementIterations,
    checksum,
  };
}

async function collectCurrentRuntimeRecords(cases) {
  const runtimeBuffer = await readFile(runtimeBundlePath);
  const workerUrl = pathToFileURL(runtimeBundlePath);
  workerUrl.searchParams.set("primary-routing-benchmark", `${process.pid}-${Date.now()}`);
  const runtime = (await import(workerUrl.href)).default;
  const environment = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  async function run(item) {
    const protectedInput = sanitizeBenchmarkQuery(item.query);
    const startedAt = process.hrtime.bigint();
    const response = await runtime.fetch(
      new Request("http://localhost/api/orchestrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: item.query, mode: "proposed", commercialJudge: false }),
      }),
      environment,
      context,
    );
    const wallMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    if (!response.ok) throw new Error(`${item.id}: proposed runtime returned HTTP ${response.status}`);
    const result = await response.json();
    const decision = result.routerDecision;
    if (!decision?.primarySelection || !Array.isArray(decision.selected)) {
      throw new Error(`${item.id}: proposed runtime did not return an MNC-16 router decision`);
    }
    const primary = result.agents?.find((agent) => agent.id === decision.primaryAgent);
    if (!primary?.evidencePlan) throw new Error(`${item.id}: primary evidence coverage is unavailable`);
    return {
      id: item.id,
      decision,
      primaryObservationAgent: primary.id,
      primaryObservation: {
        status: primary.edgeStatus,
        policyOutcome: primary.edgePolicyOutcome,
        evidenceCoverage: primary.evidencePlan,
      },
      routingQuery: protectedInput.sanitized,
      inputWasFiltered: protectedInput.filteredFields.length > 0,
      orchestrationLatencyMs: Number(result.metrics?.latencyMs ?? wallMilliseconds),
    };
  }

  const records = [];
  for (let index = 0; index < cases.length; index += 4) {
    records.push(...await Promise.all(cases.slice(index, index + 4).map(run)));
  }
  return { records: new Map(records.map((record) => [record.id, record])), runtimeBuffer };
}

function assertCurrentMirrorParity(cases) {
  const mismatches = [];
  for (const item of cases) {
    const actual = currentRuntimeRecords.get(item.id)?.decision;
    const mirror = routeCurrentMirror(currentRuntimeRecords.get(item.id)?.routingQuery ?? item.query, item);
    const actualScores = actual?.primarySelection?.rankedCandidates?.map(({ agentId, totalScore }) => ({ agentId, totalScore })) ?? [];
    const mirrorScores = mirror.primarySelection.rankedCandidates.map(({ agentId, totalScore }) => ({ agentId, totalScore }));
    const checks = {
      primaryAgent: actual?.primaryAgent === mirror.primaryAgent,
      candidateAgents: arraysEqual(actual?.candidateAgents ?? [], mirror.candidateAgents),
      required: arraysEqual(actual?.required ?? [], mirror.required),
      selected: arraysEqual(actual?.selected ?? [], mirror.selected),
      adaptiveAdditions: arraysEqual(actual?.adaptiveAdditions ?? [], mirror.adaptiveAdditions),
      rankedScores: JSON.stringify(actualScores) === JSON.stringify(mirrorScores),
    };
    if (Object.values(checks).some((passed) => !passed)) {
      mismatches.push({ id: item.id, checks, actual: {
        primaryAgent: actual?.primaryAgent,
        candidateAgents: actual?.candidateAgents,
        required: actual?.required,
        selected: actual?.selected,
        adaptiveAdditions: actual?.adaptiveAdditions,
        rankedScores: actualScores,
      }, mirror: {
        primaryAgent: mirror.primaryAgent,
        candidateAgents: mirror.candidateAgents,
        required: mirror.required,
        selected: mirror.selected,
        adaptiveAdditions: mirror.adaptiveAdditions,
        rankedScores: mirrorScores,
      } });
    }
  }
  if (mismatches.length) {
    throw new Error(`Current-router JS mirror differs from built runtime:\n${JSON.stringify(mismatches.slice(0, 3), null, 2)}`);
  }
  return {
    casesCompared: cases.length,
    exactMatches: cases.length,
    fields: ["primaryAgent", "candidateAgents", "required", "selected", "adaptiveAdditions", "ranked candidate scores"],
  };
}

function csvCell(value) {
  const serialized = Array.isArray(value) ? value.join("|") : String(value ?? "");
  return /[",\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
}

function toCsv(rows, columns) {
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\n") + "\n";
}

function gitRevision(reference) {
  try {
    return execFileSync("git", ["rev-parse", reference], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function markdownTable(summaries) {
  const header = "| Method | Macro F1 | Exact match | Critical-role recall | Primary in expected set* | Avg fan-out | Routing-policy CPU median (us/query) |";
  const divider = "|---|---:|---:|---:|---:|---:|---:|";
  const rows = summaries.map((summary) =>
    `| ${summary.label} | ${summary.macroF1.toFixed(1)}% | ${summary.exactMatchRate.toFixed(1)}% | ${summary.criticalRoleRecall.toFixed(1)}% | ${summary.primaryAccuracy.toFixed(1)}% | ${summary.averageFanOut.toFixed(2)} | ${(summary.decisionTimeMedianMs * 1_000).toFixed(2)} |`,
  );
  return [header, divider, ...rows].join("\n");
}

function buildReadme(report) {
  const extremum = (field, direction) => {
    const value = Math[direction](...report.summary.map((summary) => summary[field]));
    return {
      value,
      labels: report.summary.filter((summary) => summary[field] === value).map((summary) => summary.label).join(" / "),
    };
  };
  const macroF1 = extremum("macroF1", "max");
  const exactMatch = extremum("exactMatchRate", "max");
  const criticalRecall = extremum("criticalRoleRecall", "max");
  const primaryAccuracy = extremum("primaryAccuracy", "max");
  const lowestFanOut = extremum("averageFanOut", "min");
  const fastestDecision = extremum("decisionTimeMedianMs", "min");
  const proposed = report.summary.find((summary) => summary.method === "current_proposed_adaptive_hybrid");
  return `# Primary-Agent Routing Benchmark

This report compares four routing techniques on the repository's 40-query AX golden set. The proposed method's quality metrics come from actual built application execution; its JavaScript routing mirror must match every final \`routerDecision.selected\` before this report is written.

Generated: \`${report.generatedAt}\`

Dataset: \`${report.dataset.path}\` (SHA-256 \`${report.dataset.sha256}\`, ${report.dataset.cases} cases)

## Results

${markdownTable(report.summary)}

\*The dataset has no separately adjudicated primary label. "Primary in expected set" is therefore the primary-accuracy proxy.

On this fixed development set, the highest Macro F1 is **${macroF1.labels}** (${macroF1.value.toFixed(1)}%), while the lowest average fan-out is **${lowestFanOut.labels}** (${lowestFanOut.value.toFixed(2)}).

The proposed adaptive hybrid passed the repository regression gates and its mirror matched the built proposed runtime on ${report.currentRuntimeParity.exactMatches}/${report.currentRuntimeParity.casesCompared} cases. Its measured result is Macro F1 ${proposed.macroF1.toFixed(1)}%, Exact Match ${proposed.exactMatchRate.toFixed(1)}%, Primary-in-Expected ${proposed.primaryAccuracy.toFixed(1)}%, Critical-role Recall ${proposed.criticalRoleRecall.toFixed(1)}%, and fan-out ${proposed.averageFanOut.toFixed(2)}.

## Methods

${report.methods.map((method) => `- **${method.label}:** ${method.description}`).join("\n")}

## Selected-set contract

All set metrics use the final deduplicated Agent IDs returned by each method, including its primary. Every method receives the same application-sanitized query. No method sees golden labels while routing, and the proposed method uses the application's normal proposed-mode request path.

${report.methods.map((method) => `- **${method.label}:** ${method.selectedSetDefinition}`).join("\n")}

## Metric definitions

- **Macro F1:** unweighted mean of per-query set F1 over predicted versus \`expected_agents\`.
- **Exact match:** percentage of queries where the predicted Agent set exactly equals \`expected_agents\`.
- **Critical-role recall:** micro recall restricted to expected \`security\`, \`legal\`, \`procurement\`, and \`finance\` roles, matching the repository's routing-v2 evaluator.
- **Primary in expected set:** percentage where the selected primary belongs to \`expected_agents\`; this is a membership proxy, not a uniquely adjudicated primary label.
- **Average fan-out:** mean number of final selected Agents per query, including the primary and adaptive additions.
- **Routing-policy CPU decision time:** median batch-amortized CPU time across ${report.timing.rounds} rounds of ${report.timing.measurementIterations} repetitions of all ${report.dataset.cases} queries. Baselines time only their route function. The proposed method times its exact JS mirror of initial routing plus adaptive selection with the already-computed primary coverage supplied as input. All figures exclude orchestration, Edge retrieval, RAG, LLM, network, and process startup.

## Artifacts

- \`routing-benchmark-results.json\`: provenance, parity gate, acceptance gates, summary metrics, timing configuration, and every prediction.
- \`routing-benchmark-summary.csv\`: chart-ready aggregate data table.
- \`routing-benchmark-per-query.csv\`: raw per-query predictions and set-scoring components.
- \`routing-quality.png\`: quality comparison with a 0-100% baseline and direct labels.
- \`routing-efficiency.png\`: fan-out and routing-policy CPU comparison with zero baselines and direct labels.

## Chart descriptions (text alternative)

- **Quality chart:** four horizontal-bar panels compare all methods on a common 0-100% scale. Highest values are Macro F1 ${macroF1.labels} (${macroF1.value.toFixed(1)}%), Exact Match ${exactMatch.labels} (${exactMatch.value.toFixed(1)}%), Critical-role Recall ${criticalRecall.labels} (${criticalRecall.value.toFixed(1)}%), and Primary-in-Expected ${primaryAccuracy.labels} (${primaryAccuracy.value.toFixed(1)}%).
- **Efficiency chart:** two zero-baseline panels compare average selected Agents and routing-policy CPU median. Lowest fan-out is ${lowestFanOut.labels} (${lowestFanOut.value.toFixed(2)} Agents/query); lowest measured routing-policy median is ${fastestDecision.labels} (${(fastestDecision.value * 1_000).toFixed(2)} us/query).

## Caveats

- This is a **development-set diagnostic**, not an independent or held-out evaluation. The rule taxonomy and the 40-query fixture come from the same project and may overstate generalization.
- The golden set labels only a relevant Agent set, so primary accuracy is evaluated as set membership rather than equality to a unique ground-truth lead.
- The v2 method is a standalone reconstruction of the routing logic at \`${report.sourceRevisions.teamleadV2 ?? "unavailable"}\`; it does not execute the full v2 application.
- Proposed quality predictions come from the built deterministic proposed-mode orchestrator (bundle SHA-256 \`${report.sourceRevisions.runtimeBundleSha256}\`). The JS mirror of current \`lib/boundary-router.ts\` (source SHA-256 \`${report.sourceRevisions.currentRouterSha256}\`) is separately asserted against its primary, candidates, required roles, scores, adaptive additions, and final selected set.
- The proposed CPU timing receives primary evidence coverage as a precomputed input. Producing that coverage is outside the routing timer. The actual full deterministic orchestration median (${proposed.orchestrationLatencyMedianMs?.toFixed(1) ?? "n/a"} ms) is recorded separately and is not compared in the CPU chart.
- CPU timings are machine- and runtime-dependent microbenchmarks. They support relative routing-policy comparison here, not end-to-end service latency claims.
- No uncertainty interval is reported because this is one fixed 40-query set. Repeated or cross-validated evaluation is required before making population-level claims.
- Exact match assumes \`expected_agents\` is complete; extra defensible reviewers count as false positives.

## Reproduce

The current source and \`dist/server/index.js\` must represent the same build; otherwise the parity assertion stops report generation. From the repository root:

\`\`\`powershell
npm run build
node scripts/benchmark-primary-routing.mjs
python scripts/render-primary-routing-charts.py
\`\`\`

Chart rendering requires Pillow.
`;
}

const datasetBuffer = await readFile(datasetPath);
const cases = datasetBuffer.toString("utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse);
if (cases.length !== 40) throw new Error(`Expected 40 benchmark cases, received ${cases.length}`);

const currentRouterBuffer = await readFile(currentRouterPath);
const runtimeCollection = await collectCurrentRuntimeRecords(cases);
currentRuntimeRecords = runtimeCollection.records;
const currentRuntimeParity = assertCurrentMirrorParity(cases);

const evaluations = methodDefinitions.map((method) => {
  const evaluated = evaluateMethod(method, cases);
  const timing = measureDecisionTime(method, cases);
  return {
    method: method.id,
    label: method.label,
    description: method.description,
    predictionSource: method.predictionSource,
    timingScope: method.timingScope,
    ...evaluated.metrics,
    decisionTimeMeanMs: timing.meanMs,
    decisionTimeMedianMs: timing.medianMs,
    decisionTimeP95Ms: timing.p95Ms,
    timingChecksum: timing.checksum,
    rows: evaluated.rows,
  };
});

const acceptanceFloors = {
  macroF1: 66.5,
  exactMatchRate: 25,
  primaryAccuracy: 95,
  criticalRoleRecall: 90,
};
const currentEvaluation = evaluations.find((evaluation) => evaluation.method === "current_proposed_adaptive_hybrid");
const acceptanceChecks = Object.fromEntries(Object.entries(acceptanceFloors).map(([metric, floor]) => [metric, {
  measured: currentEvaluation[metric],
  floor,
  passed: currentEvaluation[metric] >= floor,
}]));
if (Object.values(acceptanceChecks).some((check) => !check.passed)) {
  throw new Error(`Current proposed routing failed acceptance floors: ${JSON.stringify(acceptanceChecks, null, 2)}`);
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  benchmark: "primary-agent-routing-offline-40",
  dataset: {
    path: "data/evaluation/ax-golden-set-40.jsonl",
    sha256: sha256(datasetBuffer),
    cases: cases.length,
    primaryLabelPolicy: "predicted primary belongs to expected_agents",
    criticalRoles: [...criticalRoles],
  },
  sourceRevisions: {
    currentHead: gitRevision("HEAD"),
    teamleadV2: gitRevision("remotes/teamlead/v2"),
    currentRouterSha256: sha256(currentRouterBuffer),
    runtimeBundleSha256: sha256(runtimeCollection.runtimeBuffer),
  },
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  timing: {
    unit: "milliseconds per decision",
    statisticForCharts: "median batch-amortized routing-policy CPU time",
    rounds: 5,
    warmupIterations: 10,
    measurementIterations: 50,
    includes: "routing functions; proposed also includes adaptive policy with precomputed primary coverage",
    excludes: ["orchestration", "Edge retrieval", "RAG", "LLM", "network", "process startup"],
  },
  currentRuntimeParity,
  currentAcceptance: { floors: acceptanceFloors, checks: acceptanceChecks, passed: true },
  methods: methodDefinitions.map(({ id, label, description, selectedSetDefinition, predictionSource, timingScope }) => ({
    id,
    label,
    description,
    selectedSetDefinition,
    predictionSource,
    timingScope,
  })),
  summary: evaluations.map((evaluation) => {
    const { rows, ...summary } = evaluation;
    void rows;
    return summary;
  }),
  perQuery: evaluations.flatMap((evaluation) => evaluation.rows),
  caveats: [
    "Development-set diagnostic; no independent holdout.",
    "Primary accuracy is membership in expected_agents because no unique primary label exists.",
    "v2 is a standalone reconstruction; proposed quality uses actual built application execution.",
    "Proposed routing-policy timing uses precomputed primary evidence coverage and is not end-to-end latency.",
  ],
};

const summaryRows = report.summary.map((summary) => ({
  method: summary.method,
  label: summary.label,
  prediction_source: summary.predictionSource,
  timing_scope: summary.timingScope,
  macro_f1_pct: summary.macroF1,
  exact_match_pct: summary.exactMatchRate,
  critical_role_recall_pct: summary.criticalRoleRecall,
  primary_in_expected_pct: summary.primaryAccuracy,
  average_fan_out: summary.averageFanOut,
  routing_policy_time_mean_ms: summary.decisionTimeMeanMs,
  routing_policy_time_median_ms: summary.decisionTimeMedianMs,
  routing_policy_time_p95_ms: summary.decisionTimeP95Ms,
  full_orchestration_latency_median_ms: summary.orchestrationLatencyMedianMs,
}));
const perQueryRows = report.perQuery.map((row) => ({
  method: row.method,
  id: row.id,
  domain: row.domain,
  difficulty: row.difficulty,
  predicted_primary: row.predictedPrimary,
  expected_agents: row.expectedAgents,
  predicted_agents: row.predictedAgents,
  true_positive: row.truePositive,
  false_positive: row.falsePositive,
  false_negative: row.falseNegative,
  precision: round(row.precision, 4),
  recall: round(row.recall, 4),
  f1: round(row.f1, 4),
  exact_match: row.exactMatch,
  primary_in_expected: row.primaryCorrect,
  critical_expected: row.criticalExpected,
  critical_hits: row.criticalHits,
  full_orchestration_latency_ms: row.orchestrationLatencyMs,
}));

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, "routing-benchmark-results.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(path.join(outputDirectory, "routing-benchmark-summary.csv"), toCsv(summaryRows, Object.keys(summaryRows[0])), "utf8"),
  writeFile(path.join(outputDirectory, "routing-benchmark-per-query.csv"), toCsv(perQueryRows, Object.keys(perQueryRows[0])), "utf8"),
  writeFile(path.join(outputDirectory, "README.md"), buildReadme(report), "utf8"),
]);

console.log(JSON.stringify({
  outputDirectory,
  datasetSha256: report.dataset.sha256,
  currentRuntimeParity,
  currentAcceptance: report.currentAcceptance,
  summary: summaryRows,
}, null, 2));
