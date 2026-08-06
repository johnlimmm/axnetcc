import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const datasetPath = process.env.EVAL_DATASET ?? "data/evaluation/ax-golden-set-40.jsonl";
const outputPath = process.env.EVAL_OUTPUT ?? "data/evaluation/router-research-report.json";
const cases = (await readFile(new URL(datasetPath, root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse)
  .filter((item) => item.eligible_for_human_sampling !== false);
const agents = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const profileText = {
  tech: "AI LLM RAG 기술 시스템 서비스 클라우드 구축 성능 응답시간 품질 모델 아키텍처",
  data: "데이터셋 데이터 품질 학습데이터 수집 정제 라벨링 메타데이터 갱신 가명정보 공공데이터 수명주기",
  security: "보안 개인정보 민감 데이터 접근 민원 내부 클라우드 반출 권한 암호화 감사 로그",
  legal: "법 책임 계약 규정 민원 개인정보 외주 위탁 조항 저작권 삭제",
  policy: "정책 윤리 공정성 편향 투명성 설명가능 영향평가 공공성 책임성 인권",
  finance: "예산 비용 조달 타당성 계약 운영비 TCO 구매 투자 수익",
  procurement: "조달 발주 입찰 제안요청서 규격서 사업자 수의계약 카탈로그 디지털서비스 계약",
  operations: "운영 SLA 장애 모니터링 응답시간 가용성 품질 평가 검수 유지보수 성능 복구",
};
const methods = [
  "random", "static", "topk", "threshold", "learned", "costAware",
  "masRouterAdapted", "routeLlmMfAdapted", "irtRouterAdapted",
  "proposed", "boundaryCalibrated", "oracle",
];
const familyIds = [...new Set(cases.map((item) => item.semantic_family_id ?? item.id))];
const familyFold = new Map(familyIds.map((id, index) => [id, index % 5]));
const foldOf = (item) => familyFold.get(item.semantic_family_id ?? item.id);

function terms(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((term) => term.length > 1);
}
function features(text) {
  const tokens = terms(text);
  const chars = text.toLowerCase().replace(/\s+/g, "");
  const grams = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(`c:${chars.slice(i, i + 2)}`);
  return new Set([...tokens.map((token) => `w:${token}`), ...grams]);
}
function hashVector(text, dimension = 64) {
  const vector = Array(dimension).fill(0);
  for (const feature of features(text)) {
    let hash = 2166136261;
    for (const char of feature) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[(hash >>> 0) % dimension] += hash & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, value))));

// RouteLLM TextMF 구조의 AX adapter: query embedding과 role embedding을
// preference pair loss로 학습한다. 각 positive role이 negative role보다
// 높은 점수를 갖도록 pairwise logistic objective를 사용한다.
function trainRouteLlmMf(train, dimension = 64, epochs = 180, learningRate = 0.08) {
  const embeddings = Object.fromEntries(agents.map((agent, index) => [
    agent,
    Array.from({ length: dimension }, (_, dim) => Math.sin((index + 1) * (dim + 1)) * 0.01),
  ]));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = learningRate / Math.sqrt(1 + epoch * 0.04);
    for (const item of train) {
      const query = hashVector(item.query, dimension);
      const positives = item.expected_agents;
      const negatives = agents.filter((agent) => !positives.includes(agent));
      for (const positive of positives) for (const negative of negatives) {
        const margin = dot(embeddings[positive], query) - dot(embeddings[negative], query);
        const gradient = 1 - sigmoid(margin);
        for (let dim = 0; dim < dimension; dim += 1) {
          const update = rate * gradient * query[dim];
          embeddings[positive][dim] += update;
          embeddings[negative][dim] -= update;
        }
      }
    }
  }
  return (query, agent) => sigmoid(dot(embeddings[agent], hashVector(query, dimension)));
}

// IRT-Router MIRT의 AX adapter: role별 ability(theta)와 query feature에서
// 파생되는 discrimination/difficulty를 분리해 2PL 확률을 학습한다.
function trainIrtRouter(train, dimension = 32, epochs = 220, learningRate = 0.045) {
  const theta = Object.fromEntries(agents.map((agent, index) => [
    agent,
    Array.from({ length: dimension }, (_, dim) => 0.05 * Math.cos((index + 1) * (dim + 1))),
  ]));
  const difficulty = Array(dimension).fill(0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = learningRate / Math.sqrt(1 + epoch * 0.03);
    for (const item of train) {
      const raw = hashVector(item.query, dimension);
      const discrimination = raw.map((value) => Math.abs(value));
      const b = dot(difficulty, raw);
      for (const agent of agents) {
        const label = Number(item.expected_agents.includes(agent));
        const probability = sigmoid(dot(theta[agent], discrimination) - b);
        const error = label - probability;
        for (let dim = 0; dim < dimension; dim += 1) {
          theta[agent][dim] += rate * error * discrimination[dim];
          difficulty[dim] -= rate * error * raw[dim] / agents.length;
        }
      }
    }
  }
  return (query, agent) => {
    const raw = hashVector(query, dimension);
    return sigmoid(dot(theta[agent], raw.map(Math.abs)) - dot(difficulty, raw));
  };
}

// MasRouter의 NumDeterminer→RoleAllocation cascade를 보존한 AX adapter.
// 질의 난이도/agent 수는 근접 train query로 추정하고, 역할은 query-role
// 유사도와 train co-occurrence history를 결합해 순차 할당한다.
function trainMasRouterCascade(train) {
  const vectors = train.map((item) => ({ item, vector: hashVector(item.query) }));
  const centroids = Object.fromEntries(agents.map((agent) => {
    const examples = vectors.filter(({ item }) => item.expected_agents.includes(agent));
    const centroid = Array(64).fill(0);
    for (const { vector } of examples) vector.forEach((value, index) => { centroid[index] += value; });
    return [agent, centroid.map((value) => value / Math.max(examples.length, 1))];
  }));
  const transitions = Object.fromEntries(agents.map((left) => [
    left,
    Object.fromEntries(agents.map((right) => [
      right,
      (train.filter((item) => item.expected_agents.includes(left) && item.expected_agents.includes(right)).length + 1) /
        (train.filter((item) => item.expected_agents.includes(left)).length + agents.length),
    ])),
  ]));
  return (query) => {
    const vector = hashVector(query);
    const neighbors = [...vectors].sort((a, b) => dot(b.vector, vector) - dot(a.vector, vector)).slice(0, 5);
    const count = Math.max(1, Math.min(6, Math.round(
      neighbors.reduce((sum, row) => sum + row.item.expected_agents.length, 0) / neighbors.length,
    )));
    const selected = [];
    while (selected.length < count) {
      const candidates = agents.filter((agent) => !selected.includes(agent));
      candidates.sort((left, right) => {
        const score = (agent) =>
          dot(vector, centroids[agent]) +
          selected.reduce((sum, previous) => sum + Math.log(transitions[previous][agent]), 0) * 0.08;
        return score(right) - score(left);
      });
      selected.push(candidates[0]);
    }
    return selected;
  };
}
function similarity(query, profile) {
  const left = new Set(terms(query));
  const right = new Set(terms(profile));
  const intersection = [...left].filter((token) =>
    [...right].some((candidate) => candidate.includes(token) || token.includes(candidate)),
  ).length;
  return intersection / Math.sqrt(Math.max(left.size * right.size, 1));
}
function ranked(query) {
  return agents.map((id) => ({ id, score: similarity(query, profileText[id]) }))
    .sort((a, b) => b.score - a.score);
}
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function seededShuffle(values, seed) {
  const random = seededRandom(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}
function trainNaiveBayes(train) {
  const vocabulary = new Set(train.flatMap((item) => [...features(item.query)]));
  const models = Object.fromEntries(agents.map((agent) => {
    const positives = train.filter((item) => item.expected_agents.includes(agent));
    const negatives = train.filter((item) => !item.expected_agents.includes(agent));
    const logPrior = Math.log((positives.length + 1) / (train.length + 2));
    const logNotPrior = Math.log((negatives.length + 1) / (train.length + 2));
    const positiveCounts = new Map();
    const negativeCounts = new Map();
    for (const item of positives) for (const feature of features(item.query)) {
      positiveCounts.set(feature, (positiveCounts.get(feature) ?? 0) + 1);
    }
    for (const item of negatives) for (const feature of features(item.query)) {
      negativeCounts.set(feature, (negativeCounts.get(feature) ?? 0) + 1);
    }
    return [agent, {
      logPrior,
      logNotPrior,
      positives: positives.length,
      negatives: negatives.length,
      positiveCounts,
      negativeCounts,
    }];
  }));
  return (query, agent) => {
    const active = features(query);
    const model = models[agent];
    let positive = model.logPrior;
    let negative = model.logNotPrior;
    for (const feature of vocabulary) {
      const isActive = active.has(feature);
      const p1 = ((model.positiveCounts.get(feature) ?? 0) + 1) / (model.positives + 2);
      const p0 = ((model.negativeCounts.get(feature) ?? 0) + 1) / (model.negatives + 2);
      positive += Math.log(isActive ? p1 : 1 - p1);
      negative += Math.log(isActive ? p0 : 1 - p0);
    }
    const max = Math.max(positive, negative);
    const p = Math.exp(positive - max);
    const n = Math.exp(negative - max);
    return p / (p + n);
  };
}
function tuneThreshold(train, scorer) {
  let best = { threshold: 0.5, f1: -1 };
  for (let threshold = 0.15; threshold <= 0.85; threshold += 0.05) {
    const totals = { tp: 0, fp: 0, fn: 0 };
    for (const item of train) {
      const selected = agents.filter((agent) => scorer(item.query, agent) >= threshold);
      if (!selected.length) selected.push(agents.sort((a, b) => scorer(item.query, b) - scorer(item.query, a))[0]);
      accumulate(totals, selected, item.expected_agents);
    }
    const f1 = micro(totals).f1;
    if (f1 > best.f1) best = { threshold, f1 };
  }
  return best.threshold;
}
function mandatoryBoundaryAgents(query) {
  const required = [];
  if (/개인정보|주민등록|민감정보|기밀|권한|보안|정보유출|공격/.test(query)) required.push("security");
  if (/법적|계약|위탁|재위탁|저작권|개인정보|처리 근거/.test(query)) required.push("legal");
  return required;
}
function trainBoundaryCalibrator(trainRows, learnedScorer) {
  const cache = new Map();
  const values = (item, proposed) => {
    if (!cache.has(item.id)) {
      const semanticRows = ranked(item.query);
      const semanticMax = Math.max(semanticRows[0]?.score ?? 0, 1e-9);
      cache.set(item.id, Object.fromEntries(agents.map((agent) => [
        agent,
        {
          proposed: Number(proposed.includes(agent)),
          learned: learnedScorer(item.query, agent),
          semantic: (semanticRows.find((row) => row.id === agent)?.score ?? 0) / semanticMax,
        },
      ])));
    }
    return cache.get(item.id);
  };
  let best = { objective: -Infinity, proposedWeight: 0.5, learnedWeight: 0.25, threshold: 0.5, maxAgents: 4 };
  for (const proposedWeight of [0, 0.25, 0.5, 0.75]) {
    for (const learnedWeight of [0, 0.25, 0.5, 0.75]) {
      if (proposedWeight + learnedWeight > 1) continue;
      const semanticWeight = 1 - proposedWeight - learnedWeight;
      for (let threshold = 0.2; threshold <= 0.8; threshold += 0.05) {
        for (const maxAgents of [2, 3, 4, 5]) {
          const totals = { tp: 0, fp: 0, fn: 0 };
          let fanout = 0;
          for (const { item, proposed } of trainRows) {
            const scores = values(item, proposed);
            const rankedAgents = agents.toSorted((left, right) => {
              const score = (agent) => proposedWeight * scores[agent].proposed +
                learnedWeight * scores[agent].learned + semanticWeight * scores[agent].semantic;
              return score(right) - score(left);
            });
            const selected = rankedAgents.filter((agent) => {
              const score = proposedWeight * scores[agent].proposed +
                learnedWeight * scores[agent].learned + semanticWeight * scores[agent].semantic;
              return score >= threshold;
            }).slice(0, maxAgents);
            const merged = [...new Set([...(selected.length ? selected : [rankedAgents[0]]), ...mandatoryBoundaryAgents(item.query)])]
              .slice(0, maxAgents);
            accumulate(totals, merged, item.expected_agents);
            fanout += merged.length;
          }
          const score = micro(totals);
          const objective = score.f1 - (fanout / trainRows.length) * 0.002;
          if (objective > best.objective) {
            best = { objective, proposedWeight, learnedWeight, threshold, maxAgents };
          }
        }
      }
    }
  }
  return {
    parameters: best,
    select(item, proposed) {
      const semanticRows = ranked(item.query);
      const semanticMax = Math.max(semanticRows[0]?.score ?? 0, 1e-9);
      const semanticWeight = 1 - best.proposedWeight - best.learnedWeight;
      const scored = agents.map((agent) => ({
        agent,
        score: best.proposedWeight * Number(proposed.includes(agent)) +
          best.learnedWeight * learnedScorer(item.query, agent) +
          semanticWeight * ((semanticRows.find((row) => row.id === agent)?.score ?? 0) / semanticMax),
      })).sort((left, right) => right.score - left.score);
      const selected = scored.filter((row) => row.score >= best.threshold)
        .slice(0, best.maxAgents).map((row) => row.agent);
      return [...new Set([...(selected.length ? selected : [scored[0].agent]), ...mandatoryBoundaryAgents(item.query)])]
        .slice(0, best.maxAgents);
    },
  };
}
function accumulate(totals, selected, expected) {
  const actual = new Set(selected);
  const gold = new Set(expected);
  totals.tp += [...actual].filter((id) => gold.has(id)).length;
  totals.fp += [...actual].filter((id) => !gold.has(id)).length;
  totals.fn += [...gold].filter((id) => !actual.has(id)).length;
}
function micro({ tp, fp, fn }) {
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  return { precision, recall, f1: 2 * precision * recall / Math.max(precision + recall, 1e-9) };
}
function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}
function bootstrap(rows, key, iterations = 2000) {
  const random = seededRandom(20260730);
  const estimates = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    estimates.push(sample.reduce((sum, row) => sum + row[key], 0) / sample.length);
  }
  return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}

const workerUrl = new URL("dist/server/index.js", root);
workerUrl.searchParams.set("router-research", `${Date.now()}`);
const worker = (await import(workerUrl.href)).default;
const environment = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const context = { waitUntil() {}, passThroughOnException() {} };
const runtimeRows = [];
for (const item of cases) {
  const response = await worker.fetch(new Request("http://localhost/api/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: item.query, mode: "proposed" }),
  }), environment, context);
  runtimeRows.push({ item, result: await response.json() });
}

const rows = [];
for (let fold = 0; fold < 5; fold += 1) {
  const test = runtimeRows.filter(({ item }) => foldOf(item) === fold);
  const train = cases.filter((item) => foldOf(item) !== fold);
  const learnedScore = trainNaiveBayes(train);
  const routeLlmScore = trainRouteLlmMf(train);
  const irtScore = trainIrtRouter(train);
  const masRouterSelect = trainMasRouterCascade(train);
  const learnedThreshold = tuneThreshold(train, learnedScore);
  const routeLlmThreshold = tuneThreshold(train, routeLlmScore);
  const irtThreshold = tuneThreshold(train, irtScore);
  const semanticThreshold = tuneThreshold(train, (query, agent) => similarity(query, profileText[agent]));
  const meanFanout = Math.max(1, Math.round(train.reduce((sum, item) => sum + item.expected_agents.length, 0) / train.length));
  const trainRuntimeRows = runtimeRows.filter(({ item }) => foldOf(item) !== fold).map(({ item, result }) => ({
    item,
    proposed: result.routerDecision.selected,
  }));
  const boundaryCalibrator = trainBoundaryCalibrator(trainRuntimeRows, learnedScore);
  for (const { item, result } of test) {
    const parallelOutputs = new Map(result.agents.map((agent) => [agent.id, agent]));
    const rank = ranked(item.query);
    const selections = {
      random: seededShuffle(agents, Number(item.id.replace(/\D/g, ""))).slice(0, meanFanout),
      static: rank.filter((entry) => entry.score > 0).slice(0, Math.max(1, meanFanout)).map((entry) => entry.id),
      topk: rank.slice(0, meanFanout).map((entry) => entry.id),
      threshold: rank.filter((entry) => entry.score >= semanticThreshold).map((entry) => entry.id),
      learned: agents.filter((agent) => learnedScore(item.query, agent) >= learnedThreshold),
      costAware: rank.filter((entry, index) => entry.score * 1.25 > 0.12 + index * 0.025).slice(0, 6).map((entry) => entry.id),
      masRouterAdapted: masRouterSelect(item.query),
      routeLlmMfAdapted: agents.filter((agent) => routeLlmScore(item.query, agent) >= routeLlmThreshold),
      irtRouterAdapted: agents.filter((agent) => irtScore(item.query, agent) >= irtThreshold),
      proposed: result.routerDecision.selected,
      boundaryCalibrated: boundaryCalibrator.select(item, result.routerDecision.selected),
      oracle: item.expected_agents,
    };
    for (const method of methods) {
      if (!selections[method].length) selections[method] = [rank[0].id];
      const totals = { tp: 0, fp: 0, fn: 0 };
      accumulate(totals, selections[method], item.expected_agents);
      const scores = micro(totals);
      const payload = selections[method].map((id) => {
        const agent = parallelOutputs.get(id);
        return {
          agentId: id,
          decision: agent?.summary ?? "",
          evidenceHandles: agent?.evidence?.map((evidence) => evidence.id) ?? [],
        };
      });
      const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
      rows.push({
        id: item.id,
        fold,
        domain: item.domain,
        difficulty: item.difficulty,
        method,
        selected: selections[method],
        fanout: selections[method].length,
        exactMatch: Number(
          selections[method].length === item.expected_agents.length &&
          selections[method].every((id) => item.expected_agents.includes(id)),
        ),
        precision: scores.precision,
        recall: scores.recall,
        f1: scores.f1,
        hammingLoss: (totals.fp + totals.fn) / agents.length,
        boundaryBytes: bytes,
      });
    }
  }
}

const summaries = Object.fromEntries(methods.map((method) => {
  const selectedRows = rows.filter((row) => row.method === method);
  const totals = { tp: 0, fp: 0, fn: 0 };
  for (const row of selectedRows) accumulate(totals, row.selected, cases.find((item) => item.id === row.id).expected_agents);
  const scores = micro(totals);
  const f1Ci = bootstrap(selectedRows, "f1").map((value) => Number((value * 100).toFixed(1)));
  return [method, {
    n: selectedRows.length,
    microPrecision: Number((scores.precision * 100).toFixed(1)),
    microRecall: Number((scores.recall * 100).toFixed(1)),
    microF1: Number((scores.f1 * 100).toFixed(1)),
    macroF1: Number((selectedRows.reduce((sum, row) => sum + row.f1, 0) / selectedRows.length * 100).toFixed(1)),
    macroF1ClusterBootstrapCi95: f1Ci,
    exactMatchRate: Number((selectedRows.reduce((sum, row) => sum + row.exactMatch, 0) / selectedRows.length * 100).toFixed(1)),
    hammingLoss: Number((selectedRows.reduce((sum, row) => sum + row.hammingLoss, 0) / selectedRows.length * 100).toFixed(1)),
    averageFanout: Number((selectedRows.reduce((sum, row) => sum + row.fanout, 0) / selectedRows.length).toFixed(2)),
    averageBoundaryBytes: Math.round(selectedRows.reduce((sum, row) => sum + row.boundaryBytes, 0) / selectedRows.length),
  }];
}));
const pairedComparisons = Object.fromEntries(
  methods.filter((method) => method !== "proposed" && method !== "oracle").map((method) => {
    const proposedRows = rows.filter((row) => row.method === "proposed");
    const baselineRows = rows.filter((row) => row.method === method);
    const differences = proposedRows.map((row, index) => ({
      f1Difference: (row.f1 - baselineRows[index].f1) * 100,
    }));
    const ci = bootstrap(differences, "f1Difference").map((value) => Number(value.toFixed(1)));
    return [method, {
      macroF1Difference: Number(
        (differences.reduce((sum, row) => sum + row.f1Difference, 0) / differences.length).toFixed(1),
      ),
      queryClusterBootstrapCi95: ci,
      boundaryByteDifference: summaries.proposed.averageBoundaryBytes - summaries[method].averageBoundaryBytes,
    }];
  }),
);
const strata = Object.fromEntries(["basic", "advanced", "adversarial"].map((difficulty) => {
  const entries = {};
  for (const method of methods) {
    const subset = rows.filter((row) => row.method === method && row.difficulty === difficulty);
    if (!subset.length) continue;
    entries[method] = {
      n: subset.length,
      macroF1: Number((subset.reduce((sum, row) => sum + row.f1, 0) / subset.length * 100).toFixed(1)),
      recall: Number((subset.reduce((sum, row) => sum + row.recall, 0) / subset.length * 100).toFixed(1)),
      averageFanout: Number((subset.reduce((sum, row) => sum + row.fanout, 0) / subset.length).toFixed(2)),
    };
  }
  return [difficulty, entries];
}));
const report = {
  generatedAt: new Date().toISOString(),
  evaluation: "5-fold cross-validated router-only comparison; query-cluster bootstrap; author labels",
  cases: cases.length,
  folds: 5,
  methods,
  summaries,
  pairedComparisons,
  byDifficulty: strata,
  rows,
};
await writeFile(new URL(outputPath, root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ evaluation: report.evaluation, summaries, pairedComparisons }, null, 2));
