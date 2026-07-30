import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cases = (await readFile(new URL("data/evaluation/ax-golden-set-40.jsonl", root), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const modes = ["centralized", "parallel", "masrouter", "remoterag", "proposed"];
const workerUrl = new URL("dist/server/index.js", root);
workerUrl.searchParams.set("expanded-evaluation", `${Date.now()}`);
const worker = (await import(workerUrl.href)).default;
const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };
const rows = [];

function division(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function documentFamily(id) {
  return id.split(":").slice(0, 2).join(":");
}

function seededRandom(seed = 20260730) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function bootstrapMeanCi(values, iterations = 2000) {
  const random = seededRandom();
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)],
    );
    estimates.push(mean(sample));
  }
  estimates.sort((left, right) => left - right);
  return [
    estimates[Math.floor(iterations * 0.025)],
    estimates[Math.floor(iterations * 0.975)],
  ];
}

for (const item of cases) {
  for (const mode of modes) {
    const response = await worker.fetch(
      new Request("http://localhost/api/orchestrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: item.query, mode }),
      }),
      environment,
      context,
    );
    if (!response.ok) throw new Error(`${item.id}/${mode}: HTTP ${response.status}`);
    const result = await response.json();
    const selected = result.agents.filter((agent) => agent.selected);
    const actualAgents = new Set(selected.map((agent) => agent.id));
    const expectedAgents = new Set(item.expected_agents);
    const truePositive = [...actualAgents].filter((id) => expectedAgents.has(id)).length;
    const falsePositive = [...actualAgents].filter((id) => !expectedAgents.has(id)).length;
    const falseNegative = [...expectedAgents].filter((id) => !actualAgents.has(id)).length;
    const precision = division(truePositive, truePositive + falsePositive);
    const recall = division(truePositive, truePositive + falseNegative);
    const f1 = division(2 * precision * recall, precision + recall);
    const answer = selected.map((agent) => agent.summary).join(" ");
    const serialized = JSON.stringify(result);
    const conceptRecall = division(
      item.required_concepts.filter((concept) =>
        answer.toLowerCase().includes(concept.toLowerCase())).length,
      item.required_concepts.length,
    );
    const evidenceIds = [...new Set(
      selected.flatMap((agent) => agent.evidence.map((evidence) => evidence.id)),
    )];
    const relevantFamilies = new Set(item.relevant_document_ids.map(documentFamily));
    const retrievedFamilies = [...new Set(evidenceIds.map(documentFamily))];
    const retrievalHits = retrievedFamilies.filter((family) => relevantFamilies.has(family)).length;
    const retrievalRecallAtK = division(retrievalHits, relevantFamilies.size);
    const firstRelevantRank = evidenceIds.findIndex((id) => relevantFamilies.has(documentFamily(id)));
    const reciprocalRank = firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1);
    const citationValidity = result.metrics.citationValidity / 100;
    const privacyPass = item.forbidden_output.every((value) => !serialized.includes(value)) ? 1 : 0;
    const objectiveQuality =
      conceptRecall * 0.35 +
      recall * 0.20 +
      retrievalRecallAtK * 0.20 +
      citationValidity * 0.15 +
      privacyPass * 0.10;
    rows.push({
      id: item.id,
      domain: item.domain,
      difficulty: item.difficulty,
      mode,
      truePositive,
      falsePositive,
      falseNegative,
      precision,
      recall,
      f1,
      conceptRecall,
      retrievalRecallAtK,
      reciprocalRank,
      evidenceIds,
      relevantDocumentFamilies: [...relevantFamilies],
      citationValidity,
      privacyPass,
      objectiveQuality,
      boundaryBytes: result.metrics.boundaryBytes,
      rawDataLeavesEdge: result.metrics.rawDataLeavesEdge,
    });
  }
  process.stderr.write(`완료: ${item.id} (${rows.length}/${cases.length * modes.length})\n`);
}

const round = (value) => Number(value.toFixed(1));
const summaries = Object.fromEntries(modes.map((mode) => {
  const modeRows = rows.filter((row) => row.mode === mode);
  const truePositive = modeRows.reduce((sum, row) => sum + row.truePositive, 0);
  const falsePositive = modeRows.reduce((sum, row) => sum + row.falsePositive, 0);
  const falseNegative = modeRows.reduce((sum, row) => sum + row.falseNegative, 0);
  const microPrecision = division(truePositive, truePositive + falsePositive);
  const microRecall = division(truePositive, truePositive + falseNegative);
  const microF1 = division(2 * microPrecision * microRecall, microPrecision + microRecall);
  const qualityValues = modeRows.map((row) => row.objectiveQuality * 100);
  const [qualityCiLow, qualityCiHigh] = bootstrapMeanCi(qualityValues);
  return [mode, {
    n: modeRows.length,
    objectiveQuality: round(mean(qualityValues)),
    objectiveQualityCi95: [round(qualityCiLow), round(qualityCiHigh)],
    agentMacroF1: round(mean(modeRows.map((row) => row.f1)) * 100),
    agentMicroPrecision: round(microPrecision * 100),
    agentMicroRecall: round(microRecall * 100),
    agentMicroF1: round(microF1 * 100),
    requiredConceptRecall: round(mean(modeRows.map((row) => row.conceptRecall)) * 100),
    retrievalRecallAtK: round(mean(modeRows.map((row) => row.retrievalRecallAtK)) * 100),
    retrievalMrr: round(mean(modeRows.map((row) => row.reciprocalRank)) * 100),
    citationValidity: round(mean(modeRows.map((row) => row.citationValidity)) * 100),
    privacyPassRate: round(mean(modeRows.map((row) => row.privacyPass)) * 100),
    averageBoundaryBytes: Math.round(mean(modeRows.map((row) => row.boundaryBytes))),
    rawDataLeavesEdge: modeRows.some((row) => row.rawDataLeavesEdge),
  }];
}));

const bestQuality = Math.max(...Object.values(summaries).map((item) => item.objectiveQuality));
for (const summary of Object.values(summaries)) {
  summary.qualityRetention = round(summary.objectiveQuality / bestQuality * 100);
}

const proposedRows = rows.filter((row) => row.mode === "proposed");
const pairedComparisons = {};
for (const baseline of modes.filter((mode) => mode !== "proposed")) {
  const baselineRows = rows.filter((row) => row.mode === baseline);
  const differences = proposedRows.map(
    (row, index) => (row.objectiveQuality - baselineRows[index].objectiveQuality) * 100,
  );
  const [ciLow, ciHigh] = bootstrapMeanCi(differences);
  pairedComparisons[baseline] = {
    proposedMinusBaseline: round(mean(differences)),
    ci95: [round(ciLow), round(ciHigh)],
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  cases: cases.length,
  modes,
  runs: rows.length,
  evaluationType: "author-labeled fixed AX golden set; deterministic generation; not independently adjudicated",
  retrievalK: "source-family Recall@K over up to 3 evidence chunks per selected agent",
  qualityDefinition: {
    requiredConceptRecall: 35,
    expectedAgentRecall: 20,
    retrievalRecallAtK: 20,
    citationValidity: 15,
    privacyPass: 10,
  },
  bestQuality,
  summaries,
  pairedComparisons,
  rows,
};

await writeFile(
  new URL("data/evaluation/expanded-report.json", root),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
