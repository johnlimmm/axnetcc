import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const directory = new URL("data/evaluation/openai-annotation/", root);
const candidates = (await readFile(new URL("data/evaluation/ax-candidate-set-240.jsonl", root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const candidateById = new Map(candidates.map((row) => [row.id, row]));
const rows = [];
for (let shard = 0; shard < 10; shard += 1) {
  const shardRows = (await readFile(new URL(`openai-annotation-results-shard-${shard}-of-10.jsonl`, directory), "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  rows.push(...shardRows);
}
rows.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
const ids = new Set(rows.map((row) => row.id));
if (rows.length !== 240 || ids.size !== 240) throw new Error(`Expected 240 unique rows, got ${rows.length}/${ids.size}`);
if (rows.some((row) => !candidateById.has(row.id))) throw new Error("Annotation contains unknown candidate ID");

function totals(leftKey, rightKey) {
  const counts = { tp: 0, fp: 0, fn: 0, exact: 0 };
  for (const row of rows) {
    const left = new Set(leftKey(row));
    const right = new Set(rightKey(row));
    counts.tp += [...left].filter((agent) => right.has(agent)).length;
    counts.fp += [...left].filter((agent) => !right.has(agent)).length;
    counts.fn += [...right].filter((agent) => !left.has(agent)).length;
    counts.exact += Number(left.size === right.size && [...left].every((agent) => right.has(agent)));
  }
  const precision = counts.tp / Math.max(counts.tp + counts.fp, 1);
  const recall = counts.tp / Math.max(counts.tp + counts.fn, 1);
  return {
    exactAgreementRate: counts.exact / rows.length,
    microPrecision: precision,
    microRecall: recall,
    microF1: 2 * precision * recall / Math.max(precision + recall, 1e-9),
  };
}
const finalized = rows.map((row) => {
  const candidate = candidateById.get(row.id);
  return {
    ...candidate,
    expected_agents: [...new Set(row.final.expected_agents)],
    required_concepts: [...new Set(row.final.required_concepts)],
    evidence: row.final.evidence.map((evidence) => ({
      document_id: evidence.document_id,
      span: evidence.quote,
      supports: evidence.supports,
    })),
    annotator_ids: [row.labelA.model, row.labelB.model],
    adjudicator_model: row.adjudication?.model ?? null,
    annotator_confidence: {
      A: row.labelA.annotation.confidence,
      B: row.labelB.annotation.confidence,
      final: row.final.confidence,
    },
    adjudication_status: row.disagreement ? "adjudicated" : "agreed",
    label_status: row.eligibleForHumanSampling ? "llm-adjudicated" : "human-review-required",
    eligible_for_confirmatory_test: false,
    eligible_for_human_sampling: row.eligibleForHumanSampling,
  };
});
const reviewQueue = finalized.filter((row) => row.label_status === "human-review-required");
const usage = rows.reduce((sum, row) => {
  for (const result of [row.labelA, row.labelB, row.adjudication].filter(Boolean)) {
    sum.promptTokens += result.usage?.prompt_tokens ?? 0;
    sum.completionTokens += result.usage?.completion_tokens ?? 0;
    sum.totalTokens += result.usage?.total_tokens ?? 0;
    sum.calls += 1;
  }
  return sum;
}, { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
const report = {
  generatedAt: new Date().toISOString(),
  rows: rows.length,
  models: {
    annotatorA: rows[0].labelA.model,
    annotatorB: rows[0].labelB.model,
    adjudicator: rows.find((row) => row.adjudication)?.adjudication?.model,
  },
  directAgreement: totals(
    (row) => row.labelA.annotation.expected_agents,
    (row) => row.labelB.annotation.expected_agents,
  ),
  finalVsOriginalProvisional: totals(
    (row) => row.final.expected_agents,
    (row) => candidateById.get(row.id).expected_agents,
  ),
  adjudicationRate: rows.filter((row) => row.disagreement).length / rows.length,
  groundedEligibilityRate: rows.filter((row) => row.eligibleForHumanSampling).length / rows.length,
  groundedEligibleRows: rows.filter((row) => row.eligibleForHumanSampling).length,
  humanReviewRequiredRows: reviewQueue.length,
  usage,
  interpretation: [
    "Low direct agreement means two commercial LLM calls cannot be described as two human experts.",
    "Adjudicated labels are suitable for development and for selecting a human-audit sample, not yet a confirmatory gold test.",
    "All confirmatory rows remain false until a preregistered human audit is completed.",
  ],
};
await writeFile(
  new URL("data/evaluation/openai-adjudicated-set-240.jsonl", root),
  `${finalized.map(JSON.stringify).join("\n")}\n`,
);
await writeFile(
  new URL("data/evaluation/openai-human-review-queue.jsonl", root),
  `${reviewQueue.map(JSON.stringify).join("\n")}\n`,
);
await writeFile(
  new URL("data/evaluation/openai-annotation-report.json", root),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
