import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const suppliedArguments = process.argv.slice(2).filter((argument) => argument !== "--");
const supplied = suppliedArguments[0];
if (!supplied) throw new Error("Pass the analyzed security-evidence run directory.");
const runDirectory = pathToFileURL(`${path.resolve(supplied)}${path.sep}`);
const validationDirectory = suppliedArguments[1] ? pathToFileURL(`${path.resolve(suppliedArguments[1])}${path.sep}`) : null;
const multiLlmDirectory = suppliedArguments[2] ? pathToFileURL(`${path.resolve(suppliedArguments[2])}${path.sep}`) : null;
const openaiJudgeDirectory = suppliedArguments[3] ? pathToFileURL(`${path.resolve(suppliedArguments[3])}${path.sep}`) : null;
const output = new URL("../paper/saea/", import.meta.url);
await mkdir(output, { recursive: true });

const methodRows = parseCsv(await readFile(new URL("method-summary.csv", runDirectory), "utf8"));
const ablationRows = parseCsv(await readFile(new URL("ablation-method-summary.csv", runDirectory), "utf8"));
const paired = JSON.parse(await readFile(new URL("paired-differences.json", runDirectory), "utf8"));
const config = JSON.parse(await readFile(new URL("experiment-config.json", runDirectory), "utf8"));
const router = JSON.parse(await readFile(new URL("../data/evaluation/router-research-report.json", import.meta.url), "utf8"));
const provenance = JSON.parse(await readFile(new URL("../data/evaluation/baseline-provenance.json", import.meta.url), "utf8"));
const validationRows = validationDirectory ? parseCsv(await readFile(new URL("method-summary.csv", validationDirectory), "utf8")) : [];
const validationPaired = validationDirectory ? JSON.parse(await readFile(new URL("paired-differences.json", validationDirectory), "utf8")) : null;
const validationConfig = validationDirectory ? JSON.parse(await readFile(new URL("experiment-config.json", validationDirectory), "utf8")) : null;
const multiLlmReport = multiLlmDirectory ? JSON.parse(await readFile(new URL("MULTI_LLM_REPORT.json", multiLlmDirectory), "utf8")) : null;
const openaiJudgeReport = openaiJudgeDirectory ? JSON.parse(await readFile(new URL("OPENAI_CROSS_MODEL_REPORT.json", openaiJudgeDirectory), "utf8")) : null;

const routerMethods = ["static", "topk", "threshold", "learned", "costAware", "masRouterAdapted", "routeLlmMfAdapted", "irtRouterAdapted", "proposed", "oracle"];
const routerRows = routerMethods.map((method) => ({ method, ...router.summaries[method] }));
await writeFile(new URL("TABLE_ROUTER_BASELINES.csv", output), csv(routerRows));
await writeFile(new URL("TABLE_ACQUISITION.csv", output), csv(methodRows));
await writeFile(new URL("TABLE_ABLATION.csv", output), csv(ablationRows));
if (validationRows.length) await writeFile(new URL("TABLE_ACQUISITION_VALIDATION_40.csv", output), csv(validationRows));
if (multiLlmReport) await writeFile(new URL("MULTI_LLM_JUDGE_REPORT.json", output), JSON.stringify(multiLlmReport, null, 2));
if (openaiJudgeReport) await writeFile(new URL("OPENAI_BLIND_JUDGE_REPORT.json", output), JSON.stringify(openaiJudgeReport, null, 2));
await writeFile(new URL("FIGURE_SECURITY_QUALITY_PARETO.svg", output), paretoSvg(methodRows).replace(/Evidence completion[^<]*raw disclosure trade-off/, "Evidence completion vs. raw disclosure trade-off"));

const significant = paired.comparisons.filter((row) => row.holmAdjustedP < 0.05);
const paperText = `# AXNetCC-SAEA paper results package

## Experimental hierarchy

- Acquisition main study: ${config.queries} fixed-role golden queries, ${config.methods.length} methods, ${config.scenarios.length} network scenarios, ${config.profileSeeds.length} synthetic-profile seeds, ${config.repetitions} repetitions, actual application-layer HTTP.
- Acquisition ablation: ${config.ablations.length} configurations and ${config.ablationRepetitions} repetitions per profile.
- Router secondary study: ${router.cases} author-labelled queries with ${router.folds}-fold semantic-family-grouped cross-validation.
- The 240-item LLM-adjudicated set remains provisional and is not represented as an independent human-labelled confirmatory test.

## Main acquisition table

${markdown(methodRows)}

${validationRows.length ? `## Acquisition validation (${validationConfig.queries} queries)\n\n${markdown(validationRows)}\n\nThis validation uses one execution per query/scenario/profile combination and a derived role-concept manifest. Thirteen mappings required deterministic fallback assignment. It broadens query coverage but is not an independently human-adjudicated confirmatory set. ${validationPaired.comparisons.filter((row) => row.holmAdjustedP < 0.05).length} of ${validationPaired.comparisons.length} paired metric comparisons remain below 0.05 after Holm adjustment.` : ""}

${multiLlmReport ? `## Multi-family LLM judge robustness check\n\n${multiLlmReport.completeCases} semantic-family cases were independently labelled by Qwen 2.5 3B, Llama 3.1 8B, and Gemma 3 4B. All ${multiLlmReport.completeCases * 3} calls were valid. Three-way exact agreement was ${fmt(multiLlmReport.threeWayExactAgreement)}, mean pairwise Jaccard was ${fmt(multiLlmReport.meanPairwiseJaccard)} (95% bootstrap CI ${multiLlmReport.uncertainty.meanPairwiseJaccardCi95.map(fmt).join(" to ")}), and macro Fleiss' kappa was ${fmt(multiLlmReport.macroFleissKappa)}. The 2-of-3 consensus matched the author-provisional labels with exact agreement ${fmt(multiLlmReport.consensusVsAuthorProvisional.exactAgreement)} and micro-F1 ${fmt(multiLlmReport.consensusVsAuthorProvisional.microF1)}. This low cross-family agreement is evidence of label sensitivity, not confirmation of an independent gold set.` : ""}

${openaiJudgeReport ? `## OpenAI blind-judge cross-check\n\nThe configured ${openaiJudgeReport.model} judge produced ${openaiJudgeReport.completeCases}/${openaiJudgeReport.completeCases} valid blind labels using ${openaiJudgeReport.usage.totalTokens} tokens. Against author-provisional labels it achieved exact agreement ${fmt(openaiJudgeReport.openaiVsAuthorProvisional.exactAgreement)}, mean Jaccard ${fmt(openaiJudgeReport.openaiVsAuthorProvisional.meanJaccard)}, and micro-F1 ${fmt(openaiJudgeReport.openaiVsAuthorProvisional.microF1)}. Against the aligned local three-family consensus it achieved exact agreement ${fmt(openaiJudgeReport.openaiVsLocalConsensus.exactAgreement)}, Jaccard ${fmt(openaiJudgeReport.openaiVsLocalConsensus.meanJaccard)}, and micro-F1 ${fmt(openaiJudgeReport.openaiVsLocalConsensus.microF1)}. Four-model macro Fleiss' kappa was ${fmt(openaiJudgeReport.fourModelMacroFleissKappa)}. Its mean fan-out was ${fmt(openaiJudgeReport.meanFanout)}, showing a high-recall but over-selection tendency.` : ""}

## Router table

${markdownRouter(routerRows)}

The research-based router rows are AX task adapters. MasRouter preserves the count/role cascade, RouteLLM-MF maps preference routing to role selection, and IRT-Router maps model ability to role ability. They are not upstream benchmark reproductions. Inspected provenance date: ${provenance.generatedAt}.

## Correct statistical interpretation

There are ${paired.comparisons.length} paired metric comparisons and ${significant.length} remain below 0.05 after Holm adjustment. The sampling unit is the unique query, not the HTTP trace. Empirical P95 is computed within each query-method cluster before paired comparison. With only ${config.queries} main queries, confidence intervals are necessarily coarse; statistical significance does not establish broad external validity.

## Artifacts

- \`TABLE_ACQUISITION.csv\`: query-weighted systems results.
- \`TABLE_ABLATION.csv\`: separately executed ablations.
${validationRows.length ? "- `TABLE_ACQUISITION_VALIDATION_40.csv`: separate 40-query acquisition validation.\n" : ""}- \`TABLE_ROUTER_BASELINES.csv\`: existing five-fold router results.
${multiLlmReport ? "- `MULTI_LLM_JUDGE_REPORT.json`: three-family blind-label agreement and uncertainty.\n" : ""}- \`FIGURE_SECURITY_QUALITY_PARETO.svg\`: completion versus raw boundary bytes, with policy violation encoded by color.
${openaiJudgeReport ? "- `OPENAI_BLIND_JUDGE_REPORT.json`: configured OpenAI judge and aligned four-model comparison.\n" : ""}- Run-local raw traces, configuration, environment, bootstrap, and permutation outputs remain the source of truth.

## Non-claims

No physical KOREN or packet-level measurement, real institutional secrecy validation, privacy guarantee, legal-compliance guarantee, exact upstream baseline reproduction, or independent expert validation is claimed.
`;
await writeFile(new URL("PAPER_RESULTS.md", output), paperText);

const artifactNames = ["experiment-config.json", "environment.json", "raw-traces.jsonl", "request-level-results.csv", "query-summary.csv", "method-summary.csv", "method-scenario-summary.csv", "paired-differences.json", "mode-distribution.csv", "ablation-query-summary.csv", "ablation-method-summary.csv", "ablation-paired-differences.json", "INTEGRITY_REPORT.json", "RESUME_DEDUPLICATION_AUDIT.json", "TRANSPORT_RECOVERY_AUDIT.json", "REPORT.md"];
const artifacts = [];
for (const name of artifactNames) {
  const data = await readFile(new URL(name, runDirectory));
  artifacts.push({ scope: "main", name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
if (validationDirectory) for (const name of ["experiment-config.json", "environment.json", "raw-traces.jsonl", "query-summary.csv", "method-summary.csv", "paired-differences.json", "INTEGRITY_REPORT.json", "RESUME_DEDUPLICATION_AUDIT.json", "TRANSPORT_RECOVERY_AUDIT.json", "REPORT.md"]) {
  const data = await readFile(new URL(name, validationDirectory));
  artifacts.push({ scope: "validation", name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
if (multiLlmDirectory) for (const name of ["run-config.json", "consensus-labels.jsonl", "MULTI_LLM_REPORT.json", "MULTI_LLM_REPORT.md", "ARTIFACT_MANIFEST.json", ...multiLlmReport.models.map((entry) => `${entry.model.replace(/[^a-zA-Z0-9.-]+/g, "_")}.jsonl`)]) {
  const data = await readFile(new URL(name, multiLlmDirectory));
  artifacts.push({ scope: "multi-llm", name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
if (openaiJudgeDirectory) for (const name of ["run-config.json", "responses.jsonl", "OPENAI_CROSS_MODEL_REPORT.json", "OPENAI_CROSS_MODEL_REPORT.md", "ARTIFACT_MANIFEST.json"]) {
  const data = await readFile(new URL(name, openaiJudgeDirectory));
  artifacts.push({ scope: "openai-judge", name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
for (const name of ["PAPER_RESULTS.md", "TABLE_ACQUISITION.csv", "TABLE_ABLATION.csv", "TABLE_ROUTER_BASELINES.csv", "FIGURE_SECURITY_QUALITY_PARETO.svg", ...(validationRows.length ? ["TABLE_ACQUISITION_VALIDATION_40.csv"] : []), ...(multiLlmReport ? ["MULTI_LLM_JUDGE_REPORT.json"] : []), ...(openaiJudgeReport ? ["OPENAI_BLIND_JUDGE_REPORT.json"] : [])]) {
  const data = await readFile(new URL(name, output));
  artifacts.push({ scope: "paper", name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
}
await writeFile(new URL("ARTIFACT_MANIFEST.json", output), JSON.stringify({ generatedAt: new Date().toISOString(), runId: config.runId, validationRunId: validationConfig?.runId ?? null, multiLlmRunId: multiLlmReport?.runId ?? null, openaiJudgeRunId: openaiJudgeReport?.runId ?? null, artifacts }, null, 2));
console.log(output.pathname);

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/); if (lines.length < 2) return [];
  const columns = lines[0].split(",");
  return lines.slice(1).map((line) => Object.fromEntries(splitCsv(line).map((value, index) => [columns[index], numeric(value)])));
}
function splitCsv(line) { return line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g).map((value) => value.replace(/^,/, "").replace(/^"|"$/g, "").replaceAll('""', '"')); }
function numeric(value) { return value !== "" && Number.isFinite(Number(value)) ? Number(value) : value; }
function csv(rows) { const columns = Object.keys(rows[0] ?? {}); const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`; return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n"; }
function markdown(rows) {
  return ["| Method | Completion | Policy violation | Coverage | P95 ms | Raw bytes | Weighted bytes |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |", ...rows.map((row) => `| ${row.method} | ${fmt(row.roleEvidenceCompletionRate)} | ${fmt(row.policyViolationRate)} | ${fmt(row.runtimeProxyCoverage)} | ${fmt(row.p95LatencyMs)} | ${fmt(row.rawCrossBoundaryBytes)} | ${fmt(row.sensitivityWeightedCrossBoundaryBytes)} |`)].join("\n");
}
function markdownRouter(rows) {
  return ["| Method | Macro-F1 | Exact match | Fan-out | Boundary bytes |", "| --- | ---: | ---: | ---: | ---: |", ...rows.map((row) => `| ${row.method} | ${fmt(row.macroF1)} | ${fmt(row.exactMatchRate)} | ${fmt(row.averageFanout)} | ${fmt(row.averageBoundaryBytes)} |`)].join("\n");
}
function fmt(value) { return Number(value ?? 0).toFixed(3); }
function paretoSvg(rows) {
  const width = 920; const height = 560; const left = 90; const top = 45; const plotWidth = 770; const plotHeight = 430;
  const maxX = Math.max(...rows.map((row) => Number(row.rawCrossBoundaryBytes)), 1) * 1.08;
  const x = (value) => left + Number(value) / maxX * plotWidth;
  const y = (value) => top + (1 - Number(value)) * plotHeight;
  const points = rows.map((row, index) => {
    const violation = Number(row.policyViolationRate); const color = violation > 0 ? "#c43d4b" : "#187f68";
    const labelY = y(row.roleEvidenceCompletionRate) + (index % 2 ? 18 : -10);
    return `<circle cx="${x(row.rawCrossBoundaryBytes).toFixed(1)}" cy="${y(row.roleEvidenceCompletionRate).toFixed(1)}" r="7" fill="${color}"/><text x="${(x(row.rawCrossBoundaryBytes) + 10).toFixed(1)}" y="${labelY.toFixed(1)}" font-size="13">${escapeXml(row.method)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/><text x="${width / 2}" y="25" text-anchor="middle" font-size="19" font-weight="700">Evidence completion–raw disclosure trade-off</text><line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}" stroke="#222"/><line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}" stroke="#222"/><text x="${left + plotWidth / 2}" y="535" text-anchor="middle" font-size="15">Mean raw cross-boundary bytes per query cluster</text><text x="22" y="${top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 22 ${top + plotHeight / 2})" font-size="15">Required-role evidence completion</text>${[0, 0.25, 0.5, 0.75, 1].map((tick) => `<line x1="${left - 5}" y1="${y(tick)}" x2="${left + plotWidth}" y2="${y(tick)}" stroke="#ddd"/><text x="${left - 12}" y="${y(tick) + 4}" text-anchor="end" font-size="12">${tick.toFixed(2)}</text>`).join("")}${points}<circle cx="690" cy="515" r="6" fill="#187f68"/><text x="702" y="519" font-size="12">zero policy violation</text><circle cx="815" cy="515" r="6" fill="#c43d4b"/><text x="827" y="519" font-size="12">violation observed</text></svg>`;
}
function escapeXml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
