import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cases = (await readFile(new URL("data/evaluation/ax-golden-set-40.jsonl", root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const research = JSON.parse(await readFile(new URL("data/evaluation/router-research-report.json", root), "utf8"));
const agents = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"];
const sizes = [8, 16, 24, 32];
const repeats = 8;
const methods = ["masRouterAdapted", "routeLlmMfAdapted", "irtRouterAdapted"];

function features(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((x) => x.length > 1);
  const grams = [];
  for (let i = 0; i < normalized.length - 1; i += 1) grams.push(`c:${normalized.slice(i, i + 2)}`);
  return [...new Set([...words.map((word) => `w:${word}`), ...grams])];
}
function hashVector(text, dimension = 64) {
  const vector = Array(dimension).fill(0);
  for (const feature of features(text)) {
    let hash = 2166136261;
    for (const char of feature) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[(hash >>> 0) % dimension] += hash & 1 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0)) || 1;
  return vector.map((value) => value / norm);
}
const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const sigmoid = (value) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, value))));
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function shuffled(values, seed) {
  const random = randomGenerator(seed);
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

// Greedy multilabel coverage followed by seeded random fill. This avoids declaring a
// method failed merely because an 8-query subset accidentally contains no example
// of a rare agent, while still varying the selected training queries per repeat.
function coverageSample(pool, size, seed) {
  const order = shuffled(pool, seed);
  const selected = [];
  const counts = Object.fromEntries(agents.map((agent) => [agent, 0]));
  while (selected.length < size && order.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let index = 0; index < order.length; index += 1) {
      const score = order[index].expected_agents.reduce((sum, agent) => sum + 1 / (1 + counts[agent]), 0);
      const jitter = ((seed + index * 2654435761) >>> 0) / 2 ** 32 * 1e-4;
      if (score + jitter > bestScore) {
        bestScore = score + jitter;
        bestIndex = index;
      }
    }
    const [picked] = order.splice(bestIndex, 1);
    selected.push(picked);
    for (const agent of picked.expected_agents) counts[agent] += 1;
  }
  return selected;
}
function trainRouteLlmMf(train, dimension = 64, epochs = 180, learningRate = 0.08) {
  const embeddings = Object.fromEntries(agents.map((agent, index) => [
    agent, Array.from({ length: dimension }, (_, dim) => Math.sin((index + 1) * (dim + 1)) * 0.01),
  ]));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = learningRate / Math.sqrt(1 + epoch * 0.04);
    for (const item of train) {
      const query = hashVector(item.query, dimension);
      const negatives = agents.filter((agent) => !item.expected_agents.includes(agent));
      for (const positive of item.expected_agents) for (const negative of negatives) {
        const gradient = 1 - sigmoid(dot(embeddings[positive], query) - dot(embeddings[negative], query));
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
function trainIrtRouter(train, dimension = 32, epochs = 220, learningRate = 0.045) {
  const theta = Object.fromEntries(agents.map((agent, index) => [
    agent, Array.from({ length: dimension }, (_, dim) => 0.05 * Math.cos((index + 1) * (dim + 1))),
  ]));
  const difficulty = Array(dimension).fill(0);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const rate = learningRate / Math.sqrt(1 + epoch * 0.03);
    for (const item of train) {
      const raw = hashVector(item.query, dimension);
      const discrimination = raw.map(Math.abs);
      const b = dot(difficulty, raw);
      for (const agent of agents) {
        const label = Number(item.expected_agents.includes(agent));
        const error = label - sigmoid(dot(theta[agent], discrimination) - b);
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
function trainMasRouterCascade(train) {
  const vectors = train.map((item) => ({ item, vector: hashVector(item.query) }));
  const centroids = Object.fromEntries(agents.map((agent) => {
    const examples = vectors.filter(({ item }) => item.expected_agents.includes(agent));
    const centroid = Array(64).fill(0);
    for (const { vector } of examples) vector.forEach((value, index) => { centroid[index] += value; });
    return [agent, centroid.map((value) => value / Math.max(examples.length, 1))];
  }));
  const transitions = Object.fromEntries(agents.map((left) => [left, Object.fromEntries(agents.map((right) => [
    right,
    (train.filter((item) => item.expected_agents.includes(left) && item.expected_agents.includes(right)).length + 1) /
      (train.filter((item) => item.expected_agents.includes(left)).length + agents.length),
  ]))]));
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
        const score = (agent) => dot(vector, centroids[agent]) +
          selected.reduce((sum, previous) => sum + Math.log(transitions[previous][agent]), 0) * 0.08;
        return score(right) - score(left);
      });
      selected.push(candidates[0]);
    }
    return selected;
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
function tuneThreshold(train, scorer) {
  let best = { threshold: 0.5, f1: -1 };
  for (let threshold = 0.15; threshold <= 0.85; threshold += 0.05) {
    const totals = { tp: 0, fp: 0, fn: 0 };
    for (const item of train) {
      const ranked = agents.toSorted((a, b) => scorer(item.query, b) - scorer(item.query, a));
      const selected = ranked.filter((agent) => scorer(item.query, agent) >= threshold);
      accumulate(totals, selected.length ? selected : [ranked[0]], item.expected_agents);
    }
    const f1 = micro(totals).f1;
    if (f1 > best.f1) best = { threshold, f1 };
  }
  return best.threshold;
}
function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}
function summarizeRuns(runs) {
  const f1s = runs.map((run) => run.microF1);
  return {
    observations: runs.length,
    microF1Mean: Number((f1s.reduce((a, b) => a + b, 0) / f1s.length * 100).toFixed(1)),
    repeatedSubsamplingInterval95: [
      Number((percentile(f1s, 0.025) * 100).toFixed(1)),
      Number((percentile(f1s, 0.975) * 100).toFixed(1)),
    ],
    microPrecisionMean: Number((runs.reduce((sum, run) => sum + run.microPrecision, 0) / runs.length * 100).toFixed(1)),
    microRecallMean: Number((runs.reduce((sum, run) => sum + run.microRecall, 0) / runs.length * 100).toFixed(1)),
    exactMatchMean: Number((runs.reduce((sum, run) => sum + run.exactMatch, 0) / runs.length * 100).toFixed(1)),
    averageFanout: Number((runs.reduce((sum, run) => sum + run.averageFanout, 0) / runs.length).toFixed(2)),
  };
}

const observations = [];
for (const size of sizes) for (let repeat = 0; repeat < repeats; repeat += 1) for (let fold = 0; fold < 5; fold += 1) {
  const test = cases.filter((_, index) => index % 5 === fold);
  const pool = cases.filter((_, index) => index % 5 !== fold);
  const nestedOrder = coverageSample(pool, pool.length, 20260731 + repeat * 17 + fold);
  const train = nestedOrder.slice(0, size);
  const mas = trainMasRouterCascade(train);
  const mf = trainRouteLlmMf(train);
  const irt = trainIrtRouter(train);
  const mfThreshold = tuneThreshold(train, mf);
  const irtThreshold = tuneThreshold(train, irt);
  for (const method of methods) {
    const totals = { tp: 0, fp: 0, fn: 0 };
    let exact = 0;
    let fanout = 0;
    for (const item of test) {
      const scorer = method === "routeLlmMfAdapted" ? mf : irt;
      const ranked = agents.toSorted((a, b) => scorer(item.query, b) - scorer(item.query, a));
      let selected = method === "masRouterAdapted"
        ? mas(item.query)
        : ranked.filter((agent) => scorer(item.query, agent) >= (method === "routeLlmMfAdapted" ? mfThreshold : irtThreshold));
      if (!selected.length) selected = [ranked[0]];
      accumulate(totals, selected, item.expected_agents);
      exact += Number(selected.length === item.expected_agents.length && selected.every((agent) => item.expected_agents.includes(agent)));
      fanout += selected.length;
    }
    const score = micro(totals);
    observations.push({
      method, size, repeat, fold,
      microPrecision: score.precision,
      microRecall: score.recall,
      microF1: score.f1,
      exactMatch: exact / test.length,
      averageFanout: fanout / test.length,
    });
  }
}

const curves = Object.fromEntries(methods.map((method) => [method, Object.fromEntries(sizes.map((size) => [
  size, summarizeRuns(observations.filter((row) => row.method === method && row.size === size)),
]))]));
const proposedF1 = research.summaries.proposed.microF1;
const extrapolations = Object.fromEntries(methods.map((method) => {
  const points = sizes.map((size) => ({ x: Math.log(size), y: curves[method][size].microF1Mean }));
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) /
    points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  const estimated = slope > 0 ? Math.exp((proposedF1 - intercept) / slope) : null;
  return [method, {
    model: "exploratory log-linear fit over n=8..32; not a validated forecast",
    slopePerLogTrainingCase: Number(slope.toFixed(2)),
    estimatedCasesToReachProposed: estimated && estimated <= 10000 ? Math.ceil(estimated) : null,
    reliable: false,
  }];
}));
const report = {
  generatedAt: new Date().toISOString(),
  evaluation: "5 fixed folds × 8 repeated multilabel-coverage subsamples; test queries never used for training or threshold tuning",
  limitations: [
    "Only 40 author-labeled queries are available; intervals describe subset/fold sensitivity, not population confidence.",
    "Baselines are architecture-preserving AX adapters, not exact executions of the original papers.",
    "Learning-curve extrapolations are exploratory and must not be reported as confirmed crossing points.",
  ],
  trainSizes: sizes,
  repeats,
  testQueriesPerFold: 8,
  proposedTrainingFreeReference: {
    microF1: proposedF1,
    macroF1: research.summaries.proposed.macroF1,
    averageFanout: research.summaries.proposed.averageFanout,
  },
  curves,
  extrapolations,
  observations,
};
await writeFile(new URL("data/evaluation/router-learning-curve.json", root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  evaluation: report.evaluation,
  proposedTrainingFreeReference: report.proposedTrainingFreeReference,
  curves,
  extrapolations,
}, null, 2));
