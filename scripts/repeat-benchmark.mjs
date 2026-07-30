const endpoint = process.env.BENCHMARK_URL ?? "http://localhost:3000/api/orchestrate";
const repetitions = Number(process.env.BENCHMARK_REPETITIONS ?? 3);
const modes = ["centralized", "parallel", "masrouter", "remoterag", "proposed"];
const queries = [
  "민원 상담용 생성형 AI 서비스를 도입하려고 합니다. 개인정보 보호, 클라우드 보안, 법적 책임과 예산 타당성을 종합 검토해 주세요.",
  "기관 내부 문서를 활용하는 RAG 서비스를 구축할 때 데이터 품질, 접근통제, 개인정보 처리와 운영 SLA를 검토해 주세요.",
  "공공기관 AI 사업의 PoC와 본사업 예산, 조달 요구사항, 공급사 종속 방지와 성능 검수 기준을 제안해 주세요.",
  "생성형 AI 민원 답변에서 환각, 편향, 설명가능성, 이의제기 절차와 담당자 책임을 어떻게 관리해야 합니까?",
  "외부 클라우드 LLM과 기관 내부 로컬 LLM을 비교하고 보안, 비용, 응답시간, 품질 관점의 도입 기준을 제시해 주세요.",
];

const rows = [];
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const results = await Promise.all(modes.map(async (mode) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, mode, commercialJudge: true }),
      });
      if (!response.ok) throw new Error(`${mode}: HTTP ${response.status}`);
      return response.json();
    }));
    for (const result of results) {
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
      });
    }
    process.stderr.write(`완료: 반복 ${repetition}/${repetitions}, 질의 ${queryIndex + 1}/${queries.length}\n`);
  }
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sd = (values) => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

const summary = modes.map((mode) => {
  const group = rows.filter((row) => row.mode === mode);
  const metric = (name) => group.map((row) => row[name]).filter(Number.isFinite);
  return {
    mode,
    n: group.length,
    overallMean: Number(mean(metric("overall")).toFixed(1)),
    overallSd: Number(sd(metric("overall")).toFixed(1)),
    correctness: Number(mean(metric("correctness")).toFixed(1)),
    groundedness: Number(mean(metric("groundedness")).toFixed(1)),
    completeness: Number(mean(metric("completeness")).toFixed(1)),
    ttftMs: Math.round(mean(metric("ttftMs"))),
    tpotMs: Number(mean(metric("tpotMs")).toFixed(1)),
    latencyMs: Math.round(mean(metric("latencyMs"))),
    boundaryBytes: Math.round(mean(metric("boundaryBytes"))),
    rawDataLeavesEdge: group.some((row) => row.rawDataLeavesEdge),
  };
});

const bestQuality = Math.max(...summary.map((row) => row.overallMean));
for (const row of summary) {
  row.qualityRetentionPct = Number((row.overallMean / bestQuality * 100).toFixed(1));
}

console.log(JSON.stringify({ repetitions, queries: queries.length, runs: rows.length, summary }, null, 2));
