import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arguments_ = process.argv.slice(2).filter((value) => value !== "--");
if (arguments_.length < 2) throw new Error("Pass the OpenAI blind-role run and local multi-LLM run directories.");
const openaiDirectory = pathToFileURL(`${path.resolve(arguments_[0])}${path.sep}`);
const localDirectory = pathToFileURL(`${path.resolve(arguments_[1])}${path.sep}`);
const openaiConfig = JSON.parse(await readFile(new URL("run-config.json", openaiDirectory), "utf8"));
const localConfig = JSON.parse(await readFile(new URL("run-config.json", localDirectory), "utf8"));
const openaiRows = (await readFile(new URL("responses.jsonl", openaiDirectory), "utf8")).trim().split(/\r?\n/).map(JSON.parse).filter((row) => row.status === "ok");
const openaiById = new Map(openaiRows.map((row) => [row.id, row]));
const localConsensus = (await readFile(new URL("consensus-labels.jsonl", localDirectory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const localById = new Map(localConsensus.map((row) => [row.id, row]));
const source = (await readFile(new URL(`../../../../${openaiConfig.inputFile}`, openaiDirectory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
const sourceById = new Map(source.map((row) => [row.id, row]));
const openaiIds = openaiConfig.candidateIds.filter((id) => openaiById.has(id));
const ids = openaiIds.filter((id) => localById.has(id));
const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const openaiLabels = openaiIds.map((id) => ({ id, expected_agents: openaiById.get(id).annotation.expected_agents }));
const overlappingOpenaiLabels = openaiLabels.filter((row) => localById.has(row.id));
const pairwiseLocal = [];
for (const localModel of localConfig.models) {
  const slug = localModel.replace(/[^a-zA-Z0-9.-]+/g, "_");
  const rows = (await readFile(new URL(`${slug}.jsonl`, localDirectory), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const byId = new Map(rows.filter((row) => row.status === "ok").map((row) => [row.id, row.annotation.expected_agents]));
  pairwiseLocal.push({ localModel, ...compare(overlappingOpenaiLabels, new Map(ids.map((id) => [id, { expected_agents: byId.get(id) ?? [] }]))) });
}
const fourModelMatrix = ids.map((id) => {
  const localLabels = localById.get(id).model_labels;
  return [openaiById.get(id).annotation.expected_agents, ...localConfig.models.map((model) => localLabels[model])];
});
const fourModelKappa = ids.length ? Object.fromEntries(roles.map((role) => [role, fleissKappa(fourModelMatrix.map((labels) => labels.map((set) => Number(set.includes(role)))))])) : {};
const report = {
  runId: openaiConfig.runId, model: openaiRows[0]?.model ?? openaiConfig.model, completeCases: openaiIds.length, localExactCandidateOverlapCases: ids.length,
  failures: openaiConfig.candidateIds.length - openaiRows.length,
  usage: sumUsage(openaiRows), meanElapsedMs: mean(openaiRows.map((row) => row.elapsedMs)),
  meanFanout: mean(openaiRows.map((row) => row.annotation.expected_agents.length)), meanConfidence: mean(openaiRows.map((row) => row.annotation.confidence)),
  roleSelectionRate: Object.fromEntries(roles.map((role) => [role, mean(openaiRows.map((row) => Number(row.annotation.expected_agents.includes(role))))])),
  openaiVsAuthorProvisional: compare(openaiLabels, sourceById), openaiVsLocalConsensus: ids.length ? compare(overlappingOpenaiLabels, localById) : null, pairwiseLocal,
  fourModelMacroFleissKappa: ids.length ? mean(Object.values(fourModelKappa)) : null, fourModelFleissKappaByRole: fourModelKappa,
  interpretation: "A stronger OpenAI judge is compared with three local model families and author-provisional labels; no source is treated as human gold.",
};
await writeFile(new URL("OPENAI_CROSS_MODEL_REPORT.json", openaiDirectory), JSON.stringify(report, null, 2));
await writeFile(new URL("OPENAI_CROSS_MODEL_REPORT.md", openaiDirectory), markdown(report));
const artifactNames = ["run-config.json", "responses.jsonl", "OPENAI_CROSS_MODEL_REPORT.json", "OPENAI_CROSS_MODEL_REPORT.md"];
const artifacts = [];
for (const name of artifactNames) { const data = await readFile(new URL(name, openaiDirectory)); artifacts.push({ name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }); }
await writeFile(new URL("ARTIFACT_MANIFEST.json", openaiDirectory), JSON.stringify({ runId: openaiConfig.runId, generatedAt: new Date().toISOString(), artifacts }, null, 2));
console.log(JSON.stringify(report, null, 2));

function compare(rows, references) { const pairs = rows.map((row) => [row.expected_agents, references.get(row.id)?.expected_agents ?? []]); let tp = 0; let fp = 0; let fn = 0; for (const [predicted, expected] of pairs) for (const role of roles) { const p = predicted.includes(role); const e = expected.includes(role); if (p && e) tp += 1; else if (p) fp += 1; else if (e) fn += 1; } return { exactAgreement: mean(pairs.map(([a, b]) => Number(sameSet(a, b)))), meanJaccard: mean(pairs.map(([a, b]) => jaccard(a, b))), microPrecision: tp / Math.max(1, tp + fp), microRecall: tp / Math.max(1, tp + fn), microF1: 2 * tp / Math.max(1, 2 * tp + fp + fn) }; }
function fleissKappa(matrix) { const n = matrix[0].length; const agreement = mean(matrix.map((ratings) => { const yes = ratings.reduce((sum, value) => sum + value, 0); const no = n - yes; return (yes * yes + no * no - n) / (n * (n - 1)); })); const yesRate = matrix.flat().reduce((sum, value) => sum + value, 0) / (matrix.length * n); const chance = yesRate ** 2 + (1 - yesRate) ** 2; return chance === 1 ? 1 : (agreement - chance) / (1 - chance); }
function sumUsage(rows) { return rows.reduce((sum, row) => ({ promptTokens: sum.promptTokens + Number(row.usage?.prompt_tokens ?? 0), completionTokens: sum.completionTokens + Number(row.usage?.completion_tokens ?? 0), totalTokens: sum.totalTokens + Number(row.usage?.total_tokens ?? 0) }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }); }
function sameSet(left, right) { return [...left].sort().join("|") === [...right].sort().join("|"); }
function jaccard(left, right) { const a = new Set(left); const b = new Set(right); const union = new Set([...a, ...b]); return union.size ? [...a].filter((value) => b.has(value)).length / union.size : 1; }
function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function markdown(report) { return `# OpenAI cross-model blind-role report\n\n- Model: ${report.model}\n- Complete cases: ${report.completeCases}\n- Exact candidate overlap with local panel: ${report.localExactCandidateOverlapCases}\n- Mean fan-out: ${report.meanFanout.toFixed(3)}\n- OpenAI vs author provisional: exact ${report.openaiVsAuthorProvisional.exactAgreement.toFixed(3)}, Jaccard ${report.openaiVsAuthorProvisional.meanJaccard.toFixed(3)}, micro-F1 ${report.openaiVsAuthorProvisional.microF1.toFixed(3)}\n${report.openaiVsLocalConsensus ? `- OpenAI vs local 3-family consensus: exact ${report.openaiVsLocalConsensus.exactAgreement.toFixed(3)}, Jaccard ${report.openaiVsLocalConsensus.meanJaccard.toFixed(3)}, micro-F1 ${report.openaiVsLocalConsensus.microF1.toFixed(3)}\n- Four-model macro Fleiss' kappa: ${report.fourModelMacroFleissKappa.toFixed(3)}\n` : "- Direct local-panel comparison is withheld because the fixed candidate IDs differ.\n"}- Total tokens: ${report.usage.totalTokens}\n\n${report.interpretation}\n`; }
