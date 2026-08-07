import { readFile } from "node:fs/promises";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("router-eval", `${process.pid}-${Date.now()}`);
const runtime = (await import(workerUrl.href)).default;
const environment = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const context = { waitUntil() {}, passThroughOnException() {} };

const rows = (await readFile(new URL("../data/evaluation/ax-golden-set-40.jsonl", import.meta.url), "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);

async function run(item) {
  const response = await runtime.fetch(
    new Request("http://localhost/api/orchestrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: item.query, mode: "proposed" }),
    }),
    environment,
    context,
  );
  if (!response.ok) throw new Error(`${item.id}: HTTP ${response.status}`);
  const result = await response.json();
  const expected = new Set(item.expected_agents);
  const selected = new Set(result.routerDecision?.selected ?? []);
  const truePositive = [...selected].filter((id) => expected.has(id)).length;
  const precision = truePositive / Math.max(selected.size, 1);
  const recall = truePositive / Math.max(expected.size, 1);
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return {
    id: item.id,
    expected: [...expected],
    selected: [...selected],
    primary: result.routerDecision?.primaryAgent,
    precision,
    recall,
    f1,
    exact: selected.size === expected.size && [...selected].every((id) => expected.has(id)),
    criticalExpected: item.expected_agents.filter((id) => ["security", "legal", "procurement", "finance"].includes(id)),
    humanReviewRequired: result.evidencePlan?.humanReviewRequired ?? true,
  };
}

const results = [];
for (let index = 0; index < rows.length; index += 4) {
  results.push(...await Promise.all(rows.slice(index, index + 4).map(run)));
}

const average = (key) => results.reduce((sum, row) => sum + row[key], 0) / results.length;
const expectedCount = results.reduce((sum, row) => sum + row.expected.length, 0);
const selectedCount = results.reduce((sum, row) => sum + row.selected.length, 0);
const truePositiveCount = results.reduce(
  (sum, row) => sum + row.selected.filter((id) => row.expected.includes(id)).length,
  0,
);
const criticalExpectedCount = results.reduce((sum, row) => sum + row.criticalExpected.length, 0);
const criticalHitCount = results.reduce(
  (sum, row) => sum + row.criticalExpected.filter((id) => row.selected.includes(id)).length,
  0,
);
const summary = {
  cases: results.length,
  macroPrecision: Number((average("precision") * 100).toFixed(1)),
  macroRecall: Number((average("recall") * 100).toFixed(1)),
  macroF1: Number((average("f1") * 100).toFixed(1)),
  microPrecision: Number((truePositiveCount / selectedCount * 100).toFixed(1)),
  microRecall: Number((truePositiveCount / expectedCount * 100).toFixed(1)),
  exactMatchRate: Number((results.filter((row) => row.exact).length / results.length * 100).toFixed(1)),
  primaryInExpectedRate: Number((results.filter((row) => row.expected.includes(row.primary)).length / results.length * 100).toFixed(1)),
  criticalRoleRecall: Number((criticalHitCount / Math.max(criticalExpectedCount, 1) * 100).toFixed(1)),
  averageFanout: Number((selectedCount / results.length).toFixed(2)),
  humanReviewRate: Number((results.filter((row) => row.humanReviewRequired).length / results.length * 100).toFixed(1)),
};

console.log(JSON.stringify({ summary, misses: results.filter((row) => row.recall < 1) }, null, 2));

const floors = {
  macroF1: 66.5,
  microRecall: 76.3,
  exactMatchRate: 25,
  primaryInExpectedRate: 95,
  criticalRoleRecall: 90,
};
for (const [metric, floor] of Object.entries(floors)) {
  if (summary[metric] < floor) {
    console.error(`${metric} regression: ${summary[metric]} < ${floor}`);
    process.exitCode = 1;
  }
}
