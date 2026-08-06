import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const routerPath = process.env.ROUTER_REPORT ?? "data/evaluation/router-research-report.json";
const statisticsOutput = process.env.STATISTICS_OUTPUT ?? "data/evaluation/statistical-validity-report.json";
const datasetPath = process.env.STATISTICS_DATASET ?? "data/evaluation/ax-golden-set-40.jsonl";
const focalMethod = process.env.FOCAL_METHOD ?? "proposed";
const router = JSON.parse(await readFile(new URL(routerPath, root), "utf8"));
const expanded = JSON.parse(await readFile(new URL("data/evaluation/expanded-report.json", root), "utf8"));
const evaluationCases = (await readFile(new URL(datasetPath, root), "utf8"))
  .split(/\r?\n/).filter(Boolean).map(JSON.parse);
const familyById = new Map(evaluationCases.map((item) => [item.id, item.semantic_family_id ?? item.id]));
const baselines = router.methods.filter((method) => ![focalMethod, "oracle"].includes(method));

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function pairedPermutation(differences, iterations = 100000) {
  const observed = Math.abs(differences.reduce((a, b) => a + b, 0) / differences.length);
  const random = seededRandom(20260731);
  let extreme = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const estimate = differences.reduce((sum, difference) => sum + (random() < 0.5 ? difference : -difference), 0) /
      differences.length;
    if (Math.abs(estimate) >= observed - 1e-12) extreme += 1;
  }
  return (extreme + 1) / (iterations + 1);
}
function clusterBootstrapMeanCi(values, iterations = 50000) {
  const random = seededRandom(20260801);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    estimates.push(total / values.length);
  }
  estimates.sort((a, b) => a - b);
  return [
    estimates[Math.floor(iterations * 0.025)],
    estimates[Math.floor(iterations * 0.975)],
  ];
}
function combination(n, k) {
  const size = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= size; index += 1) result = result * (n - size + index) / index;
  return result;
}
function exactMcNemar(b, c) {
  const discordant = b + c;
  if (!discordant) return 1;
  const lower = Math.min(b, c);
  let tail = 0;
  for (let index = 0; index <= lower; index += 1) tail += combination(discordant, index) * 0.5 ** discordant;
  return Math.min(1, 2 * tail);
}
function holm(rows) {
  const ordered = [...rows].sort((a, b) => a.pValue - b.pValue);
  let previous = 0;
  ordered.forEach((row, index) => {
    const adjusted = Math.min(1, row.pValue * (ordered.length - index));
    row.holmAdjustedPValue = Math.max(previous, adjusted);
    previous = row.holmAdjustedPValue;
  });
}
function dominates(left, right, qualityKey, byteKey) {
  return left[qualityKey] >= right[qualityKey] && left[byteKey] <= right[byteKey] &&
    (left[qualityKey] > right[qualityKey] || left[byteKey] < right[byteKey]);
}

const routerTests = baselines.map((baseline) => {
  const proposed = router.rows.filter((row) => row.method === focalMethod).toSorted((a, b) => a.id.localeCompare(b.id));
  const compared = router.rows.filter((row) => row.method === baseline).toSorted((a, b) => a.id.localeCompare(b.id));
  const queryDifferences = proposed.map((row, index) => ({
    family: familyById.get(row.id) ?? row.id,
    difference: row.f1 - compared[index].f1,
  }));
  const families = [...new Set(queryDifferences.map((row) => row.family))];
  const differences = families.map((family) => {
    const values = queryDifferences.filter((row) => row.family === family).map((row) => row.difference);
    return values.reduce((a, b) => a + b, 0) / values.length;
  });
  let proposedOnlyExact = 0;
  let baselineOnlyExact = 0;
  proposed.forEach((row, index) => {
    if (row.exactMatch && !compared[index].exactMatch) proposedOnlyExact += 1;
    if (!row.exactMatch && compared[index].exactMatch) baselineOnlyExact += 1;
  });
  const nonZero = differences.filter((value) => value !== 0);
  const familyCi = clusterBootstrapMeanCi(differences).map((value) => Number((value * 100).toFixed(2)));
  return {
    baseline,
    nQueries: queryDifferences.length,
    nIndependentSemanticFamilies: differences.length,
    meanPairedMacroF1DifferencePoints: Number((differences.reduce((a, b) => a + b, 0) / differences.length * 100).toFixed(2)),
    semanticFamilyBootstrapCi95Points: familyCi,
    nonInferiorAtFivePointMargin: familyCi[0] > -5,
    winTieLoss: {
      wins: queryDifferences.filter((value) => value.difference > 0).length,
      ties: queryDifferences.filter((value) => value.difference === 0).length,
      losses: queryDifferences.filter((value) => value.difference < 0).length,
    },
    pairedPermutationPValue: pairedPermutation(differences),
    pairedEffectSizeDz: Number((
      (differences.reduce((a, b) => a + b, 0) / differences.length) /
      Math.sqrt(nonZero.reduce((sum, value) => sum + (value - nonZero.reduce((a, b) => a + b, 0) / nonZero.length) ** 2, 0) /
        Math.max(nonZero.length - 1, 1))
    ).toFixed(3)),
    exactMatchDiscordance: { proposedOnlyExact, baselineOnlyExact },
    exactMcNemarPValue: exactMcNemar(proposedOnlyExact, baselineOnlyExact),
    approximateQueriesFor80PercentPower: Number.isFinite(
      (1.96 + 0.8416) ** 2 / (
        (differences.reduce((a, b) => a + b, 0) / differences.length) /
        Math.sqrt(nonZero.reduce((sum, value) => sum + (value - nonZero.reduce((a, b) => a + b, 0) / nonZero.length) ** 2, 0) /
          Math.max(nonZero.length - 1, 1))
      ) ** 2,
    ) ? Math.ceil((1.96 + 0.8416) ** 2 / (
      (differences.reduce((a, b) => a + b, 0) / differences.length) /
      Math.sqrt(nonZero.reduce((sum, value) => sum + (value - nonZero.reduce((a, b) => a + b, 0) / nonZero.length) ** 2, 0) /
        Math.max(nonZero.length - 1, 1))
    ) ** 2) : null,
  };
});
const permutationRows = routerTests.map((row) => ({ row, pValue: row.pairedPermutationPValue }));
holm(permutationRows);
permutationRows.forEach(({ row, holmAdjustedPValue }) => { row.pairedPermutationHolmPValue = holmAdjustedPValue; });

const routerPoints = Object.entries(router.summaries)
  .filter(([method]) => method !== "oracle")
  .map(([method, summary]) => ({
    method,
    macroF1: summary.macroF1,
    boundaryBytes: summary.averageBoundaryBytes,
  }));
for (const point of routerPoints) {
  point.paretoOptimal = !routerPoints.some((other) => other.method !== point.method &&
    dominates(other, point, "macroF1", "boundaryBytes"));
  point.dominatedBy = routerPoints.filter((other) => other.method !== point.method &&
    dominates(other, point, "macroF1", "boundaryBytes")).map((other) => other.method);
}

const modes = Object.keys(expanded.summaries);
const qualityPoints = modes.map((mode) => ({
  mode,
  objectiveQuality: expanded.summaries[mode].objectiveQuality,
  boundaryBytes: expanded.summaries[mode].averageBoundaryBytes,
  rawDataLeavesEdge: expanded.summaries[mode].rawDataLeavesEdge,
}));
for (const point of qualityPoints) {
  point.paretoOptimal = !qualityPoints.some((other) => other.mode !== point.mode &&
    dominates(other, point, "objectiveQuality", "boundaryBytes"));
  point.dominatedBy = qualityPoints.filter((other) => other.mode !== point.mode &&
    dominates(other, point, "objectiveQuality", "boundaryBytes")).map((other) => other.mode);
}

const report = {
  generatedAt: new Date().toISOString(),
  protocol: {
    focalMethod,
    unitOfAnalysis: "semantic-family cluster for F1 inference; unique query for descriptive metrics",
    pairedPermutationIterations: 100000,
    familyWiseErrorCorrection: "Holm across router baselines",
    exactMatchTest: "two-sided exact McNemar",
    paretoObjectives: ["maximize quality", "minimize cross-boundary bytes"],
    caveat: "Author labels and 40 queries limit external validity; p-values do not remove this limitation.",
  },
  routerTests,
  routerPareto: routerPoints,
  endToEndPareto: qualityPoints,
};
await writeFile(new URL(statisticsOutput, root), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
