import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = (await readFile(new URL("data/evaluation/ax-golden-set-40.jsonl", root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const corpus = JSON.parse(await readFile(new URL("data/rag-corpus.json", root), "utf8")).documents;
const corpusById = new Map(corpus.map((document) => [document.id, document]));
const organizations = [
  { id: "central-government", prefix: "중앙행정기관에서" },
  { id: "local-government", prefix: "지방자치단체에서" },
  { id: "enterprise", prefix: "민간기업에서" },
];
const angles = [
  {
    id: "architecture-design",
    prompt: "실제 구축 아키텍처와 단계별 의사결정 기준까지 제시해 주세요.",
    agent: "tech",
    concept: "아키텍처",
  },
  {
    id: "compliance-audit",
    prompt: "감사 시 확인할 통제항목과 증적, 책임자를 구분해 주세요.",
    agent: "security",
    concept: "감사증적",
  },
  {
    id: "incident-response",
    prompt: "장애 또는 정보유출 발생 시 탐지·격리·복구 절차를 포함해 주세요.",
    agent: "operations",
    concept: "사고대응",
  },
  {
    id: "contract-procurement",
    prompt: "발주·계약 단계의 요구사항과 검수 조건으로 바꾸어 주세요.",
    agent: "procurement",
    concept: "검수조건",
  },
  {
    id: "performance-cost",
    prompt: "정량 KPI, 측정 주기, 예산 영향을 함께 산정해 주세요.",
    agent: "finance",
    concept: "정량KPI",
  },
  {
    id: "governance-scaleout",
    prompt: "여러 부서와 기관으로 확산할 때의 승인·책임·예외처리 체계를 설계해 주세요.",
    agent: "policy",
    concept: "거버넌스",
  },
];

const rows = [];
function terms(text) {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length > 1));
}
function retrieveForAgent(query, agent) {
  const queryTerms = terms(query);
  return corpus.filter((document) => document.agent === agent).map((document) => {
    const documentTerms = terms(`${document.title} ${document.section} ${document.text}`);
    const overlap = [...queryTerms].filter((term) => documentTerms.has(term)).length;
    return { document, score: overlap / Math.sqrt(Math.max(queryTerms.size * documentTerms.size, 1)) };
  }).sort((left, right) => right.score - left.score)[0]?.document;
}
for (const [sourceIndex, item] of source.entries()) {
  for (const [angleIndex, angle] of angles.entries()) {
    const organization = organizations[(sourceIndex + angleIndex) % organizations.length];
    const expectedAgents = [...new Set([...item.expected_agents, angle.agent])];
    const forcedAdversarial = angle.id === "incident-response" ||
      (angle.id === "compliance-audit" && sourceIndex % 2 === 0);
    const difficulty = forcedAdversarial ? "adversarial" : item.difficulty === "adversarial" ? "advanced" : item.difficulty;
    const adversarialContext = forcedAdversarial
      ? " 권한 오용, 감사로그 누락, 민감정보 노출을 가정한 공격·장애 조건에서"
      : "";
    const dataClass = angle.id === "incident-response" ? "confidential" :
      ["compliance-audit", "contract-procurement", "governance-scaleout"].includes(angle.id) ? "internal" : "public";
    const query = `${organization.prefix}${adversarialContext} ${item.query.replace(/[.]\s*$/, "")} ${angle.prompt}`;
    const inherited = item.relevant_document_ids.map((id) => corpusById.get(id)).filter(Boolean);
    const retrieved = expectedAgents.map((agent) => retrieveForAgent(query, agent)).filter(Boolean);
    const evidenceDocuments = [...new Map([...inherited, ...retrieved].map((document) => [document.id, document])).values()];
    rows.push({
      id: `CAND-${String(rows.length + 1).padStart(3, "0")}`,
      group_id: `${item.id}-${angle.id}`,
      semantic_family_id: item.id,
      source_case_id: item.id,
      organization: organization.id,
      domain: item.domain,
      task_angle: angle.id,
      difficulty,
      data_class: dataClass,
      query,
      expected_agents: expectedAgents,
      required_concepts: [...new Set([...item.required_concepts, angle.concept])],
      evidence: evidenceDocuments.map((document) => ({
        document_id: document.id,
        span: "독립 라벨러가 원문 근거 구간을 확정해야 함",
        supports: `후보 근거: ${document.agent}`,
      })),
      forbidden_output: item.forbidden_output,
      annotator_ids: [],
      adjudication_status: "pending",
      label_status: "provisional",
      split: "unassigned",
      eligible_for_confirmatory_test: false,
    });
  }
}

await writeFile(
  new URL("data/evaluation/ax-candidate-set-240.jsonl", root),
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
const blindRows = rows.map((row) => ({
  id: row.id,
  semantic_family_id: row.semantic_family_id,
  organization: row.organization,
  domain: row.domain,
  task_angle: row.task_angle,
  difficulty: row.difficulty,
  data_class: row.data_class,
  query: row.query,
  expected_agents: [],
  required_concepts: [],
  evidence: [],
  forbidden_output: [],
  annotator_confidence: null,
  annotator_rationale: "",
}));
await mkdir(new URL("data/evaluation/annotation/", root), { recursive: true });
for (const annotator of ["A", "B"]) {
  await writeFile(
    new URL(`data/evaluation/annotation/blind-annotator-${annotator}.jsonl`, root),
    `${blindRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}
const counts = (key) => Object.fromEntries([...new Set(rows.map((row) => row[key]))]
  .map((value) => [value, rows.filter((row) => row[key] === value).length]));
const manifest = {
  generatedAt: new Date().toISOString(),
  rows: rows.length,
  sourcePilotCases: source.length,
  purpose: "annotation candidate pool; not an independent benchmark",
  restrictions: [
    "Do not report these 240 generated candidates as 240 independently authored test queries.",
    "All labels and evidence spans are provisional until two independent annotators and adjudication are complete.",
    "Split by semantic_family_id to prevent paraphrase/source-case leakage.",
    "Only eligible_for_confirmatory_test=true rows may enter a confirmatory test.",
  ],
  distribution: {
    organization: counts("organization"),
    taskAngle: counts("task_angle"),
    difficulty: counts("difficulty"),
    dataClass: counts("data_class"),
  },
};
await writeFile(new URL("data/evaluation/ax-candidate-set-240-manifest.json", root), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
