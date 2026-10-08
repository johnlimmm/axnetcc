export const METRIC_PROVENANCE_VERSION = "v2" as const;

export type MetricProvenanceKind =
  | "measured"
  | "derived"
  | "estimated"
  | "unavailable";

export type MetricProvenance = {
  version: typeof METRIC_PROVENANCE_VERSION;
  kind: MetricProvenanceKind;
  source: string;
  method: string;
  detail?: string;
};

export type MetricReading<T> = {
  value: T | null;
  provenance: MetricProvenance;
};

type ProvenanceInput = Omit<MetricProvenance, "version" | "kind">;

function provenance(
  kind: MetricProvenanceKind,
  input: ProvenanceInput,
): MetricProvenance {
  return {
    version: METRIC_PROVENANCE_VERSION,
    kind,
    source: input.source,
    method: input.method,
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

export function measuredMetric<T>(
  value: T,
  input: ProvenanceInput,
): MetricReading<T> {
  return { value, provenance: provenance("measured", input) };
}

export function derivedMetric<T>(
  value: T,
  input: ProvenanceInput,
): MetricReading<T> {
  return { value, provenance: provenance("derived", input) };
}

export function estimatedMetric<T>(
  value: T,
  input: ProvenanceInput,
): MetricReading<T> {
  return { value, provenance: provenance("estimated", input) };
}

export function unavailableMetric<T>(
  input: ProvenanceInput,
): MetricReading<T> {
  return { value: null, provenance: provenance("unavailable", input) };
}

export type InferenceTokenCount = {
  promptTokens: number | null | undefined;
  completionTokens: number | null | undefined;
};

export type AggregatedTokenCount = {
  inferenceCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

function isTokenCount(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Sums model-reported counters only when every inference has both counters.
 * A partial sum would look precise while systematically under-reporting usage,
 * so an empty input or a single missing/invalid counter yields null instead.
 */
export function aggregateInferenceTokenCounts(
  inferences: readonly InferenceTokenCount[],
): MetricReading<AggregatedTokenCount> {
  const source = "model-reported prompt/completion token counters";
  const method = "sum every inference only when all promptTokens and completionTokens are available";
  if (inferences.length === 0) {
    return unavailableMetric({
      source,
      method,
      detail: "No inference was recorded.",
    });
  }

  const missingIndex = inferences.findIndex(
    (item) => !isTokenCount(item.promptTokens) || !isTokenCount(item.completionTokens),
  );
  if (missingIndex >= 0) {
    return unavailableMetric({
      source,
      method,
      detail: `Inference ${missingIndex} is missing a valid token counter; partial totals are not reported.`,
    });
  }

  const totals = inferences.reduce<{ promptTokens: number; completionTokens: number }>(
    (sum, item) => ({
      promptTokens: sum.promptTokens + (item.promptTokens as number),
      completionTokens: sum.completionTokens + (item.completionTokens as number),
    }),
    { promptTokens: 0, completionTokens: 0 },
  );
  return derivedMetric({
    inferenceCount: inferences.length,
    ...totals,
    totalTokens: totals.promptTokens + totals.completionTokens,
  }, {
    source,
    method,
    detail: "Exact aggregate derived from complete measured counters; no character-length estimate is used.",
  });
}

/** Calculates request wall-clock time without adding inferred Agent delays. */
export function calculateElapsedMetric(
  startedAt: number,
  completedAt = Date.now(),
): MetricReading<number> {
  const source = "request wall clock";
  const method = "completedAt - startedAt";
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt
  ) {
    return unavailableMetric({
      source,
      method,
      detail: "Timestamps must be finite and completedAt must not precede startedAt.",
    });
  }
  return measuredMetric(completedAt - startedAt, { source, method });
}

export type CitationTraceability = {
  score: number;
  claimCount: number;
  citedClaimCount: number;
  validlyCitedClaimCount: number;
  citationCount: number;
  validCitationCount: number;
};

const citationPattern = /\[([^\[\]\r\n]{1,256})\]/gu;

function splitClaims(text: string) {
  return text
    .normalize("NFKC")
    .slice(0, 50_000)
    .split(/\n+|(?<=[.!?。！？])\s*/u)
    .map((claim) => claim.trim().replace(/^[-*•]\s*/u, ""))
    .filter((claim) => {
      const withoutCitations = claim.replace(citationPattern, " ");
      return (withoutCitations.match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((term) => term.length > 1)
        .length >= 2;
    })
    .slice(0, 200);
}

/**
 * Measures syntactic claim-to-evidence linkage. This deliberately does not
 * claim semantic entailment: a claim is traceable only when it has citations
 * and every citation on that claim exists in the supplied evidence ID set.
 */
export function calculateCitationTraceability(
  text: string,
  evidenceIds: Iterable<string>,
): MetricReading<CitationTraceability> {
  const source = "final answer citations and returned evidence IDs";
  const method = "100 * fully-validly-cited claims / substantive claims";
  const claims = splitClaims(text);
  if (claims.length === 0) {
    return unavailableMetric({
      source,
      method,
      detail: "No substantive claim was available for citation analysis.",
    });
  }

  const validIds = new Set(
    [...evidenceIds]
      .map((id) => id.trim())
      .filter(Boolean),
  );
  let citedClaimCount = 0;
  let validlyCitedClaimCount = 0;
  let citationCount = 0;
  let validCitationCount = 0;

  for (const claim of claims) {
    const citations = [...claim.matchAll(citationPattern)]
      .map((match) => match[1].trim())
      .filter(Boolean);
    citationCount += citations.length;
    validCitationCount += citations.filter((id) => validIds.has(id)).length;
    if (citations.length > 0) citedClaimCount += 1;
    if (citations.length > 0 && citations.every((id) => validIds.has(id))) {
      validlyCitedClaimCount += 1;
    }
  }

  return derivedMetric({
    score: Math.round(validlyCitedClaimCount / claims.length * 100),
    claimCount: claims.length,
    citedClaimCount,
    validlyCitedClaimCount,
    citationCount,
    validCitationCount,
  }, {
    source,
    method,
    detail: "Citation linkage is verifiable but does not establish semantic entailment; that requires a separate evaluator.",
  });
}

export type AgentClaimSource = {
  agentId: string;
  text: string;
};

export type ClaimPolarity = "positive" | "negative";

export type DetectedClaimConflict = {
  leftAgentId: string;
  rightAgentId: string;
  leftClaim: string;
  rightClaim: string;
  leftPolarity: ClaimPolarity;
  rightPolarity: ClaimPolarity;
  sharedTerms: string[];
  topicSimilarity: number;
};

export type ClaimConflictAnalysis = {
  status: "detected" | "none-detected" | "not-evaluable";
  evaluatedClaimCount: number;
  positiveClaimCount: number;
  negativeClaimCount: number;
  conflicts: DetectedClaimConflict[];
  provenance: MetricProvenance;
};

const negativeMarkers = [
  "허용하지 않아야", "허용하지 않는다", "허용하지 않", "사용할 수 없다",
  "전송할 수 없다", "반출할 수 없다", "공유할 수 없다", "제공할 수 없다",
  "금지해야", "금지한다", "금지", "불가능", "불가", "차단해야", "차단한다",
  "must not", "should not", "not allowed", "cannot", "can't", "forbidden", "prohibited",
] as const;

const positiveMarkers = [
  "허용해야", "허용한다", "허용 가능", "사용할 수 있다", "전송할 수 있다",
  "반출할 수 있다", "공유할 수 있다", "제공할 수 있다", "승인한다",
  "must allow", "should allow", "is allowed", "allowed", "can", "may",
] as const;

const topicStopWords = new Set([
  "그리고", "그러나", "따라서", "다만", "대한", "위한", "통해", "경우", "관련",
  "해야", "한다", "있다", "없다", "된다", "것이다", "합니다", "됩니다",
  "and", "but", "therefore", "the", "a", "an", "to", "of", "for", "is", "be",
]);

function polarityOf(claim: string): ClaimPolarity | null {
  const normalized = claim.toLowerCase().normalize("NFKC");
  if (negativeMarkers.some((marker) => normalized.includes(marker))) return "negative";
  if (positiveMarkers.some((marker) => normalized.includes(marker))) return "positive";
  return null;
}

function stripKoreanParticle(token: string) {
  if (token.length < 3) return token;
  return token.replace(/(?:에게서|으로서|으로|에서|에게|한테|까지|부터|처럼|보다|이나|거나|은|는|이|가|을|를|에|로|와|과|도|만|의)$/u, "");
}

function topicTerms(claim: string) {
  let normalized = claim.toLowerCase().normalize("NFKC").replace(citationPattern, " ");
  for (const marker of [...negativeMarkers, ...positiveMarkers]) {
    normalized = normalized.split(marker).join(" ");
  }
  return new Set(
    (normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(stripKoreanParticle)
      .filter((term) => term.length > 1 && !topicStopWords.has(term)),
  );
}

function topicOverlap(left: Set<string>, right: Set<string>) {
  const sharedTerms = [...left].filter((term) => right.has(term)).sort();
  const smallerSize = Math.min(left.size, right.size);
  return {
    sharedTerms,
    similarity: smallerSize > 0 ? sharedTerms.length / smallerSize : 0,
  };
}

/**
 * Finds only explicit allow/deny contradictions about strongly overlapping
 * topics. It intentionally returns "none-detected", never a guarantee that the
 * answers are globally conflict-free.
 */
export function detectExplicitClaimConflicts(
  sources: readonly AgentClaimSource[],
): ClaimConflictAnalysis {
  const evaluated = sources.flatMap((source) =>
    splitClaims(source.text).map((claim) => ({
      agentId: source.agentId,
      claim,
      polarity: polarityOf(claim),
      terms: topicTerms(claim),
    })),
  ).filter((item): item is typeof item & { polarity: ClaimPolarity } => item.polarity !== null);

  const conflicts: DetectedClaimConflict[] = [];
  for (let leftIndex = 0; leftIndex < evaluated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < evaluated.length; rightIndex += 1) {
      const left = evaluated[leftIndex];
      const right = evaluated[rightIndex];
      if (left.polarity === right.polarity) continue;
      const overlap = topicOverlap(left.terms, right.terms);
      if (overlap.sharedTerms.length < 2 || overlap.similarity < 0.75) continue;
      conflicts.push({
        leftAgentId: left.agentId,
        rightAgentId: right.agentId,
        leftClaim: left.claim,
        rightClaim: right.claim,
        leftPolarity: left.polarity,
        rightPolarity: right.polarity,
        sharedTerms: overlap.sharedTerms,
        topicSimilarity: Number(overlap.similarity.toFixed(3)),
      });
    }
  }

  const positiveClaimCount = evaluated.filter((item) => item.polarity === "positive").length;
  const negativeClaimCount = evaluated.filter((item) => item.polarity === "negative").length;
  return {
    status: conflicts.length
      ? "detected"
      : evaluated.length > 0 ? "none-detected" : "not-evaluable",
    evaluatedClaimCount: evaluated.length,
    positiveClaimCount,
    negativeClaimCount,
    conflicts,
    provenance: provenance("derived", {
      source: "Agent response claims",
      method: "explicit allow/deny polarity with >=2 shared topic terms and >=0.75 containment similarity",
      detail: "Conservative lexical detection; none-detected is not proof that no semantic conflict exists.",
    }),
  };
}
