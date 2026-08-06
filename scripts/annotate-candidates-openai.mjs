import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const inputFile = process.argv[2] ?? "data/evaluation/ax-candidate-set-240.jsonl";
const limit = Number(process.env.ANNOTATION_LIMIT ?? 240);
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required. Do not store it in the repository.");
const endpoint = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const modelA = process.env.OPENAI_ANNOTATOR_MODEL_A ?? "gpt-5.4-mini";
const modelB = process.env.OPENAI_ANNOTATOR_MODEL_B ?? "gpt-5-mini";
const adjudicatorModel = process.env.OPENAI_ADJUDICATOR_MODEL ?? "gpt-5.4-mini";
const agentIds = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const allCandidates = (await readFile(new URL(inputFile, root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse).slice(0, limit);
const shardCount = Math.max(1, Number(process.env.ANNOTATION_SHARD_COUNT ?? 1));
const shardIndex = Math.max(0, Number(process.env.ANNOTATION_SHARD_INDEX ?? 0));
const candidates = allCandidates.filter((_, index) => index % shardCount === shardIndex);
const shardSuffix = shardCount > 1 ? `-shard-${shardIndex}-of-${shardCount}` : "";
const corpus = JSON.parse(await readFile(new URL("data/rag-corpus.json", root), "utf8")).documents;
const documents = new Map(corpus.map((document) => [document.id, document]));
const outputDir = new URL("data/evaluation/openai-annotation/", root);
await mkdir(outputDir, { recursive: true });

const schema = {
  name: "expert_annotation",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["expected_agents", "required_concepts", "evidence", "confidence", "rationale", "needs_human_review"],
    properties: {
      expected_agents: {
        type: "array",
        items: { type: "string", enum: agentIds },
      },
      required_concepts: { type: "array", items: { type: "string" } },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["document_id", "quote", "supports"],
          properties: {
            document_id: { type: "string" },
            quote: { type: "string" },
            supports: { type: "string" },
          },
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string" },
      needs_human_review: { type: "boolean" },
    },
  },
};
const roleGuide = agentIds.map((id) => ({
  tech: "시스템 아키텍처, LLM/RAG, 구현 및 성능",
  data: "데이터 품질, 수명주기, 메타데이터, 학습데이터",
  security: "접근통제, 개인정보 안전조치, 공격과 보안",
  legal: "법적 근거, 계약 책임, 개인정보·저작권 법률",
  policy: "공공성, 윤리, 설명가능성, 거버넌스",
  finance: "예산, TCO, 비용과 경제성",
  procurement: "발주, 제안요청서, 조달과 검수",
  operations: "SLA, 장애, 모니터링, 운영 절차",
}[id])).map((description, index) => `${agentIds[index]}: ${description}`).join("\n");

function evidenceContext(candidate) {
  return candidate.evidence.map(({ document_id: id }) => documents.get(id)).filter(Boolean).map((document) =>
    `[${document.id}]\n제목: ${document.title}\n출처: ${document.sourceUrl}\n발행일: ${document.publishedAt}\n내용:\n${document.text.slice(0, 5000)}`,
  ).join("\n\n");
}
async function request(model, system, user) {
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json();
  return {
    annotation: JSON.parse(payload.choices?.[0]?.message?.content ?? "{}"),
    responseId: payload.id,
    usage: payload.usage,
    model: payload.model ?? model,
  };
}
function commonUser(candidate) {
  return `질의:\n${candidate.query}\n\n허용 전문 역할:\n${roleGuide}\n\n검토 가능한 공공문서 근거:\n${evidenceContext(candidate) ||
    "연결된 원문 chunk가 없음. needs_human_review=true로 판정할 것."}`;
}
function sameSet(left, right) {
  return [...left].sort().join("|") === [...right].sort().join("|");
}
function validEvidence(annotation, candidate) {
  const allowed = new Set(candidate.evidence.map((item) => item.document_id));
  return annotation.evidence.every((item) => allowed.has(item.document_id) && item.quote.trim().length >= 5);
}

let records = [];
if (process.env.ANNOTATION_RESUME === "true") {
  try {
    records = (await readFile(new URL(`openai-annotation-progress${shardSuffix}.jsonl`, outputDir), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse)
      .filter((row) => candidates.some((candidate) => candidate.id === row.id));
  } catch {
    records = [];
  }
}
const completedIds = new Set(records.map((row) => row.id));
const pendingCandidates = candidates.filter((candidate) => !completedIds.has(candidate.id));
for (const [index, candidate] of pendingCandidates.entries()) {
  const labelA = await request(
    modelA,
    "당신은 공공·기업 AX 아키텍처 심사위원이다. 답변 작성에 직접 필수인 역할만 최소 집합으로 선택한다. " +
      "질의에 설계·감사·비용 같은 단어가 등장한다는 이유만으로 관련 역할을 모두 추가하지 않는다. " +
      "통상 1~4개 역할을 선택하며, 해당 역할 없이 핵심 산출물을 만들 수 없는 경우에만 포함한다. " +
      "needs_human_review는 역할 집합 자체를 결정할 수 없을 때만 true로 한다. 제공 문서는 역할 필요성을 뒷받침하는 데 사용한다.",
    commonUser(candidate),
  );
  const labelB = await request(
    modelB,
    "당신은 독립적인 공공 AI 위험·업무 분석 전문가다. 누락 비용을 고려하되 답변에 직접 기여하지 않는 역할은 넣지 않는다. " +
      "일반적인 지원 가능성과 이 질의에 반드시 필요한 전문 역할을 구분한다. " +
      "최소 역할 원칙에 따라 통상 1~4개만 선택한다. needs_human_review는 역할 집합을 결정할 수 없을 때만 true로 한다.",
    commonUser(candidate),
  );
  const disagreement = !sameSet(labelA.annotation.expected_agents, labelB.annotation.expected_agents) ||
    !validEvidence(labelA.annotation, candidate) || !validEvidence(labelB.annotation, candidate);
  let adjudication = null;
  if (disagreement) {
    adjudication = await request(
      adjudicatorModel,
      "당신은 두 독립 라벨의 불일치를 조정하는 수석 심사위원이다. 다수결하지 말고 제공 문서와 역할 정의로 판정한다. " +
        "핵심 산출물에 직접 필수인 최소 역할만 통상 1~4개 선택한다. 역할 집합 자체를 결정할 수 있을 때는 " +
        "일부 답변 근거가 부족하다는 이유만으로 needs_human_review=true로 하지 않는다.",
      `${commonUser(candidate)}\n\n라벨 A:\n${JSON.stringify(labelA.annotation)}\n\n라벨 B:\n${JSON.stringify(labelB.annotation)}`,
    );
  }
  const final = adjudication?.annotation ?? labelA.annotation;
  const eligible = !final.needs_human_review && validEvidence(final, candidate) &&
    (adjudication !== null || sameSet(labelA.annotation.expected_agents, labelB.annotation.expected_agents));
  records.push({
    id: candidate.id,
    source: {
      corpusGeneratedAt: JSON.parse(await readFile(new URL("data/rag-corpus.json", root), "utf8")).generatedAt,
      documentIds: candidate.evidence.map((item) => item.document_id),
    },
    labelA,
    labelB,
    disagreement,
    adjudication,
    final,
    eligibleForHumanSampling: eligible,
    eligibleForConfirmatoryTest: false,
    requirement: "Confirmatory promotion still requires human audit of a preregistered sample and leakage-safe split.",
  });
  await writeFile(
    new URL(`openai-annotation-progress${shardSuffix}.jsonl`, outputDir),
    `${records.map(JSON.stringify).join("\n")}\n`,
  );
  console.log(
    `[${records.length}/${candidates.length}] ${candidate.id} disagreement=${disagreement} eligible=${eligible}`,
  );
}
await writeFile(
  new URL(`openai-annotation-results${shardSuffix}.jsonl`, outputDir),
  `${records.map(JSON.stringify).join("\n")}\n`,
);
console.log(JSON.stringify({
  rows: records.length,
  shard: { index: shardIndex, count: shardCount },
  models: { labelA: modelA, labelB: modelB, adjudicator: adjudicatorModel },
  agreementRate: records.filter((row) => !row.disagreement).length / records.length,
  eligibleForHumanSampling: records.filter((row) => row.eligibleForHumanSampling).length,
}, null, 2));
