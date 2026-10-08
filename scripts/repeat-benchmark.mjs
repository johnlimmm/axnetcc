import { writeFile } from "node:fs/promises";
import {
  PRIVACY_REPORT_SCHEMA_VERSION,
  PRIVACY_RISK_VERSION,
  assertPrivacyRowsV2,
  normalizePrivacyBreakdownV2,
  summarizePrivacyRowsV2,
} from "./privacy-report-contract.mjs";

const root = new URL("../", import.meta.url);
const endpoint = process.env.BENCHMARK_URL?.trim() || null;
const repetitions = Number(process.env.BENCHMARK_REPETITIONS ?? 3);
const modes = ["centralized", "parallel", "masrouter", "remoterag", "proposed"];
const queries = [
  "민원 상담용 생성형 AI 서비스를 도입하려고 합니다. 개인정보 보호, 클라우드 보안, 법적 책임과 예산 타당성을 종합 검토해 주세요.",
  "기관 내부 문서를 사용하는 RAG 서비스를 구축할 때 데이터 품질, 접근통제, 개인정보 처리와 운영 SLA를 검토해 주세요.",
  "공공기관 AI 사업의 PoC와 본사업 예산, 조달 요구사항, 공급사 종속 방지와 성능 검증 기준을 제안해 주세요.",
  "생성형 AI 민원 응답에서 편향, 환각, 설명가능성, 이의제기 절차와 담당 책임을 어떻게 관리해야 합니까?",
  "외부 클라우드 LLM과 기관 내부 로컬 LLM을 비교하고 보안, 비용, 응답시간, 품질 관점의 도입 기준을 제시해 주세요.",
];

let builtWorker = null;
if (!endpoint) {
  const workerUrl = new URL("dist/server/index.js", root);
  workerUrl.searchParams.set("repeat-benchmark", `${process.pid}-${Date.now()}`);
  builtWorker = (await import(workerUrl.href)).default;
}
const workerEnvironment = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const workerContext = { waitUntil() {}, passThroughOnException() {} };

async function execute(mode, query) {
  const request = new Request(endpoint ?? "http://localhost/api/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, mode, commercialJudge: true }),
  });
  const response = endpoint
    ? await fetch(request)
    : await builtWorker.fetch(request, workerEnvironment, workerContext);
  if (!response.ok) throw new Error(`${mode}: HTTP ${response.status}`);
  return response.json();
}

const rows = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const results = await Promise.all(modes.map((mode) => execute(mode, query)));
    for (const result of results) {
      const privacyRisk = normalizePrivacyBreakdownV2(
        result.metrics,
        `repeat ${repetition}/query ${queryIndex + 1}/${result.mode}.metrics`,
      );
      rows.push({
        repetition,
        query: queryIndex + 1,
        mode: result.mode,
        correctness: result.commercialJudge?.correctness ?? null,
        groundedness: result.commercialJudge?.groundedness ?? null,
        completeness: result.commercialJudge?.completeness ?? null,
        overall: result.commercialJudge?.overall ?? null,
        ttftMs: result.metrics.ttftMs,
        tpotMs: result.metrics.tpotMs,
        latencyMs: result.metrics.latencyMs,
        boundaryBytes: result.metrics.boundaryBytes,
        rawDataLeavesEdge: result.metrics.rawDataLeavesEdge,
        privacyRiskVersion: PRIVACY_RISK_VERSION,
        privacyRisk,
      });
    }
    process.stderr.write(`완료: 반복 ${repetition}/${repetitions}, 질의 ${queryIndex + 1}/${queries.length}\n`);
  }
}

assertPrivacyRowsV2(rows, "repeat benchmark rows");
const mean = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
const rounded = (value, digits = 1) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : null;
const sd = (values) => {
  const average = mean(values);
  if (!Number.isFinite(average)) return null;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const summary = modes.map((mode) => {
  const group = rows.filter((row) => row.mode === mode);
  const metric = (name) => group.map((row) => row[name]).filter(Number.isFinite);
  const privacyRisk = summarizePrivacyRowsV2(group, `repeat ${mode} rows`);
  return {
    mode,
    n: group.length,
    overallMean: rounded(mean(metric("overall"))),
    overallSd: rounded(sd(metric("overall"))),
    correctness: rounded(mean(metric("correctness"))),
    groundedness: rounded(mean(metric("groundedness"))),
    completeness: rounded(mean(metric("completeness"))),
    ttftMs: rounded(mean(metric("ttftMs")), 0),
    tpotMs: rounded(mean(metric("tpotMs"))),
    latencyMs: rounded(mean(metric("latencyMs")), 0),
    boundaryBytes: rounded(mean(metric("boundaryBytes")), 0),
    rawDataLeavesEdge: group.some((row) => row.rawDataLeavesEdge),
    averagePrivacyRiskScore: privacyRisk.averageScore,
    privacyRisk,
  };
});

const measuredQuality = summary.map((row) => row.overallMean).filter(Number.isFinite);
const bestQuality = measuredQuality.length ? Math.max(...measuredQuality) : null;
for (const row of summary) {
  row.qualityRetentionPct = Number.isFinite(row.overallMean) && bestQuality > 0
    ? rounded(row.overallMean / bestQuality * 100)
    : null;
}

const completedJudgeRuns = rows.filter((row) => Number.isFinite(row.overall)).length;
const report = {
  schemaVersion: PRIVACY_REPORT_SCHEMA_VERSION,
  privacyRiskVersion: PRIVACY_RISK_VERSION,
  status: completedJudgeRuns === rows.length ? "measured" : "partial",
  generatedAt: new Date().toISOString(),
  executionTransport: endpoint ? "external-http" : "built-worker-in-process",
  commercialJudgeConfigured: Boolean(
    process.env.COMMERCIAL_JUDGE_BASE_URL &&
    process.env.COMMERCIAL_JUDGE_API_KEY &&
    process.env.COMMERCIAL_JUDGE_MODEL
  ),
  repetitions,
  queries: queries.length,
  runs: rows.length,
  completedRuns: rows.length,
  completedJudgeRuns,
  expectedRuns: repetitions * queries.length * modes.length,
  legacyReportsExcluded: ["data/evaluation/literature-baseline-report.json"],
  summary,
  rows,
};

await writeFile(
  new URL("data/evaluation/repeat-benchmark-report-v2.json", root),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({
  output: "data/evaluation/repeat-benchmark-report-v2.json",
  status: report.status,
  runs: report.runs,
  completedJudgeRuns: report.completedJudgeRuns,
  commercialJudgeConfigured: report.commercialJudgeConfigured,
  summary: report.summary,
}, null, 2));
