import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const supplied = process.argv.slice(2).find((argument) => argument !== "--");
if (!supplied) throw new Error("Pass a multi-LLM annotation run directory.");
const directory = pathToFileURL(`${path.resolve(supplied)}${path.sep}`);
const config = JSON.parse(await readFile(new URL("run-config.json", directory), "utf8"));
const allSource = (await readFile(new URL(`../../../../${config.inputFile}`, directory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const candidateIdSet = new Set(config.candidateIds ?? allSource.slice(0, config.candidates).map((row) => row.id));
const source = allSource.filter((row) => candidateIdSet.has(row.id));
const sourceById = new Map(source.map((row) => [row.id, row]));
const recordsByModel = new Map();
for (const model of config.models) {
  const slug = model.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const rows = (await readFile(new URL(`${slug}.jsonl`, directory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  recordsByModel.set(model, new Map(rows.filter((row) => row.status === "ok").map((row) => [row.id, row])));
}
const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const completeIds = source.map((row) => row.id).filter((id) => config.models.every((model) => recordsByModel.get(model).has(id)));
const consensus = [];
for (const id of completeIds) {
  const annotations = config.models.map((model) => recordsByModel.get(model).get(id).annotation);
  const expectedAgents = roles.filter((role) => annotations.filter((annotation) => annotation.expected_agents.includes(role)).length >= Math.ceil(config.models.length / 2));
  consensus.push({ id, expected_agents: expectedAgents, agreement: allSame(annotations.map((row) => row.expected_agents)), meanPairwiseJaccard: meanPairs(annotations.map((row) => row.expected_agents), jaccard), needs_review: annotations.filter((row) => row.needs_review).length >= 2, model_labels: Object.fromEntries(config.models.map((model, index) => [model, annotations[index].expected_agents])) });
}
const pairwise = [];
for (let left = 0; left < config.models.length; left += 1) for (let right = left + 1; right < config.models.length; right += 1) {
  const labels = completeIds.map((id) => [recordsByModel.get(config.models[left]).get(id).annotation.expected_agents, recordsByModel.get(config.models[right]).get(id).annotation.expected_agents]);
  pairwise.push({ left: config.models[left], right: config.models[right], exactAgreement: mean(labels.map(([a, b]) => Number(sameSet(a, b)))), meanJaccard: mean(labels.map(([a, b]) => jaccard(a, b))) });
}
const kappaByRole = Object.fromEntries(roles.map((role) => [role, fleissKappa(completeIds.map((id) => config.models.map((model) => Number(recordsByModel.get(model).get(id).annotation.expected_agents.includes(role)))))]));
const comparison = compare(consensus, sourceById);
const failures = Object.fromEntries(config.models.map((model) => [model, config.candidates - recordsByModel.get(model).size]));
const modelSummaries = Object.fromEntries(config.models.map((model) => {
  const rows = completeIds.map((id) => recordsByModel.get(model).get(id));
  return [model, { meanFanout: mean(rows.map((row) => row.annotation.expected_agents.length)), meanConfidence: mean(rows.map((row) => row.annotation.confidence)), reviewRate: mean(rows.map((row) => Number(row.annotation.needs_review))), meanElapsedMs: mean(rows.map((row) => row.elapsedMs)), roleSelectionRate: Object.fromEntries(roles.map((role) => [role, mean(rows.map((row) => Number(row.annotation.expected_agents.includes(role))))])) }];
}));
const uncertainty = {
  threeWayExactAgreementCi95: bootstrap(consensus, (rows) => mean(rows.map((row) => Number(row.agreement)))),
  meanPairwiseJaccardCi95: bootstrap(consensus, (rows) => mean(rows.map((row) => row.meanPairwiseJaccard))),
  consensusVsAuthorExactCi95: bootstrap(consensus, (rows) => compare(rows, sourceById).exactAgreement),
  consensusVsAuthorJaccardCi95: bootstrap(consensus, (rows) => compare(rows, sourceById).meanJaccard),
};
const report = { runId: config.runId, candidates: config.candidates, completeCases: completeIds.length, models: config.modelProvenance, failures, modelSummaries, threeWayExactAgreement: mean(consensus.map((row) => Number(row.agreement))), meanPairwiseJaccard: mean(consensus.map((row) => row.meanPairwiseJaccard)), uncertainty, pairwise, fleissKappaByRole: kappaByRole, macroFleissKappa: mean(Object.values(kappaByRole).filter(Number.isFinite)), consensusVsAuthorProvisional: comparison, consensusReviewRate: mean(consensus.map((row) => Number(row.needs_review))), interpretation: "Multi-family local LLM consensus is an independent-model robustness check, not independent human ground truth." };
await writeFile(new URL("consensus-labels.jsonl", directory), `${consensus.map(JSON.stringify).join("\n")}\n`);
await writeFile(new URL("MULTI_LLM_REPORT.json", directory), JSON.stringify(report, null, 2));
await writeFile(new URL("MULTI_LLM_REPORT.md", directory), markdown(report));
const artifactNames = ["run-config.json", ...config.models.map((model) => `${model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.jsonl`), "consensus-labels.jsonl", "MULTI_LLM_REPORT.json", "MULTI_LLM_REPORT.md"];
const artifacts = [];
for (const name of artifactNames) { const data = await readFile(new URL(name, directory)); artifacts.push({ name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }); }
await writeFile(new URL("ARTIFACT_MANIFEST.json", directory), JSON.stringify({ runId: config.runId, generatedAt: new Date().toISOString(), artifacts }, null, 2));
console.log(JSON.stringify(report, null, 2));

function compare(rows, labels) {
  const pairs = rows.map((row) => [row.expected_agents, labels.get(row.id)?.expected_agents ?? []]);
  let tp = 0; let fp = 0; let fn = 0;
  for (const [predicted, expected] of pairs) for (const role of roles) { const p = predicted.includes(role); const e = expected.includes(role); if (p && e) tp += 1; else if (p) fp += 1; else if (e) fn += 1; }
  return { exactAgreement: mean(pairs.map(([a, b]) => Number(sameSet(a, b)))), meanJaccard: mean(pairs.map(([a, b]) => jaccard(a, b))), microPrecision: tp / Math.max(1, tp + fp), microRecall: tp / Math.max(1, tp + fn), microF1: 2 * tp / Math.max(1, 2 * tp + fp + fn) };
}
function fleissKappa(matrix) {
  if (!matrix.length) return null;
  const n = matrix[0].length;
  const agreement = mean(matrix.map((ratings) => { const yes = ratings.reduce((sum, value) => sum + value, 0); const no = n - yes; return (yes * yes + no * no - n) / (n * (n - 1)); }));
  const yesRate = matrix.flat().reduce((sum, value) => sum + value, 0) / (matrix.length * n);
  const chance = yesRate ** 2 + (1 - yesRate) ** 2;
  return chance === 1 ? 1 : (agreement - chance) / (1 - chance);
}
function allSame(sets) { return sets.every((set) => sameSet(set, sets[0])); }
function sameSet(left, right) { return [...left].sort().join("|") === [...right].sort().join("|"); }
function jaccard(left, right) { const a = new Set(left); const b = new Set(right); const union = new Set([...a, ...b]); return union.size ? [...a].filter((value) => b.has(value)).length / union.size : 1; }
function meanPairs(values, fn) { const scores = []; for (let left = 0; left < values.length; left += 1) for (let right = left + 1; right < values.length; right += 1) scores.push(fn(values[left], values[right])); return mean(scores); }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function bootstrap(rows, statistic) { const random = mulberry32(20260806); const values = []; for (let sample = 0; sample < 10000; sample += 1) values.push(statistic(Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]))); values.sort((a, b) => a - b); return [values[Math.floor(values.length * 0.025)], values[Math.floor(values.length * 0.975)]]; }
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
function markdown(report) { return `# Multi-family LLM blind annotation report\n\n- Run: ${report.runId}\n- Complete cases: ${report.completeCases}/${report.candidates}\n- Three-way exact agreement: ${report.threeWayExactAgreement.toFixed(3)}\n- Mean pairwise Jaccard: ${report.meanPairwiseJaccard.toFixed(3)}\n- Macro Fleiss' kappa across roles: ${report.macroFleissKappa.toFixed(3)}\n- Consensus vs author provisional micro-F1: ${report.consensusVsAuthorProvisional.microF1.toFixed(3)}\n- Consensus vs author provisional exact agreement: ${report.consensusVsAuthorProvisional.exactAgreement.toFixed(3)}\n- Consensus review rate: ${report.consensusReviewRate.toFixed(3)}\n\n## Pairwise\n\n${report.pairwise.map((row) => `- ${row.left} vs ${row.right}: exact ${row.exactAgreement.toFixed(3)}, Jaccard ${row.meanJaccard.toFixed(3)}`).join("\n")}\n\n## Interpretation\n\n${report.interpretation}\n`; }
