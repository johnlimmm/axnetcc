import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cases = (await readFile(new URL("data/evaluation/golden-set.jsonl", root), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const modes = ["centralized", "managed", "parallel", "proposed"];
const workerUrl = new URL("dist/server/index.js", root);
workerUrl.searchParams.set("benchmark", `${Date.now()}`);
const worker = (await import(workerUrl.href)).default;
const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };
const rows = [];

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
    const result = await response.json();
    const selected = result.agents.filter((agent) => agent.selected);
    const actual = new Set(selected.map((agent) => agent.id));
    const expected = new Set(item.expected_agents);
    const truePositive = [...actual].filter((id) => expected.has(id)).length;
    const precision = truePositive / Math.max(actual.size, 1);
    const recall = truePositive / Math.max(expected.size, 1);
    const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
    const answer = selected.map((agent) => agent.summary).join(" ");
    const serialized = JSON.stringify(result);
    const conceptRecall = item.required_concepts
      .filter((concept) => answer.toLowerCase().includes(concept.toLowerCase())).length /
      Math.max(item.required_concepts.length, 1);
    const retrievalSuccess = selected.every((agent) => agent.evidence.length > 0) ? 1 : 0;
    const citationValidity = result.metrics.citationValidity / 100;
    const completeness = result.metrics.answerCompleteness / 100;
    const objectiveQuality =
      conceptRecall * 0.45 +
      recall * 0.20 +
      retrievalSuccess * 0.15 +
      citationValidity * 0.10 +
      completeness * 0.10;
    rows.push({
      id: item.id,
      mode,
      precision,
      recall,
      f1,
      conceptRecall,
      retrievalSuccess,
      citationValidity,
      privacyPass: item.forbidden_output.every((value) => !serialized.includes(value)) ? 1 : 0,
      objectiveQuality,
      boundaryBytes: result.metrics.boundaryBytes,
      privacyRisk: result.metrics.privacyRiskScore,
      latencyMs: result.metrics.latencyMs,
    });
  }
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value) => Number(value.toFixed(1));
const summaries = Object.fromEntries(modes.map((mode) => {
  const modeRows = rows.filter((row) => row.mode === mode);
  return [mode, {
    quality: round(average(modeRows.map((row) => row.objectiveQuality)) * 100),
    conceptRecall: round(average(modeRows.map((row) => row.conceptRecall)) * 100),
    agentSelectionF1: round(average(modeRows.map((row) => row.f1)) * 100),
    retrievalSuccessRate: round(average(modeRows.map((row) => row.retrievalSuccess)) * 100),
    citationValidity: round(average(modeRows.map((row) => row.citationValidity)) * 100),
    privacyPassRate: round(average(modeRows.map((row) => row.privacyPass)) * 100),
    averageBoundaryBytes: Math.round(average(modeRows.map((row) => row.boundaryBytes))),
    averagePrivacyRisk: round(average(modeRows.map((row) => row.privacyRisk))),
    averageLatencyMs: Math.round(average(modeRows.map((row) => row.latencyMs))),
  }];
}));
const bestQuality = Math.max(...Object.values(summaries).map((item) => item.quality));
for (const summary of Object.values(summaries)) {
  summary.qualityRetention = round(summary.quality / Math.max(bestQuality, 0.1) * 100);
}
const proposed = summaries.proposed;
const bestQualityMode = modes.find((mode) => summaries[mode].quality === bestQuality);

const report = {
  generatedAt: new Date().toISOString(),
  cases: cases.length,
  model: process.env.LOCAL_LLM_MODEL ?? "deterministic fallback / local model compatible",
  method: "fixed pilot golden set; not a held-out test",
  qualityDefinition: {
    requiredConceptRecall: 45,
    expectedAgentRecall: 20,
    retrievalSuccess: 15,
    citationValidity: 10,
    answerCompleteness: 10,
  },
  bestQualityMode,
  bestQuality,
  proposedAdvantage: {
    qualityRetention: proposed.qualityRetention,
    privacyRiskReductionVsCentralized: round(
      (1 - proposed.averagePrivacyRisk / summaries.centralized.averagePrivacyRisk) * 100,
    ),
    boundaryByteReductionVsCentralized: round(
      (1 - proposed.averageBoundaryBytes / summaries.centralized.averageBoundaryBytes) * 100,
    ),
  },
  modes: summaries,
  rows,
};

await writeFile(
  new URL("data/evaluation/latest-report.json", root),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
