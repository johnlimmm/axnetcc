import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cases = (await readFile(new URL("data/evaluation/golden-set.jsonl", root), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);
const workerUrl = new URL("dist/server/index.js", root);
workerUrl.searchParams.set("benchmark", `${Date.now()}`);
const worker = (await import(workerUrl.href)).default;
const environment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };
const rows = [];

for (const item of cases) {
  const response = await worker.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: item.query, mode: "proposed" }),
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
  const serialized = JSON.stringify(result);
  rows.push({
    id: item.id,
    precision,
    recall,
    f1,
    retrievalSuccess: selected.every((agent) => agent.evidence.length > 0) ? 1 : 0,
    citationValidity: result.metrics.citationValidity / 100,
    privacyPass: item.forbidden_output.every((value) => !serialized.includes(value)) ? 1 : 0,
    qualityProxy: result.metrics.qualityScore / 100,
  });
}

const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
const report = {
  generatedAt: new Date().toISOString(),
  cases: rows.length,
  model: process.env.LOCAL_LLM_MODEL ?? "agent-specific local model",
  method: "fixed held-out golden set",
  metrics: {
    agentSelectionPrecision: Number((mean("precision") * 100).toFixed(1)),
    agentSelectionRecall: Number((mean("recall") * 100).toFixed(1)),
    agentSelectionF1: Number((mean("f1") * 100).toFixed(1)),
    retrievalSuccessRate: Number((mean("retrievalSuccess") * 100).toFixed(1)),
    citationValidity: Number((mean("citationValidity") * 100).toFixed(1)),
    privacyPassRate: Number((mean("privacyPass") * 100).toFixed(1)),
    averageQualityProxy: Number((mean("qualityProxy") * 100).toFixed(1)),
  },
  rows,
};

await writeFile(
  new URL("data/evaluation/latest-report.json", root),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
