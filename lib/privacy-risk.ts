export const PRIVACY_RISK_VERSION = "v2" as const;

export type ProtectedSource = {
  id: string;
  kind: "user-input" | "restricted-rag";
  text: string;
};

export type OriginalTextRange = {
  /** UTF-16 string offset, matching JavaScript String#slice. */
  start: number;
  /** Exclusive UTF-16 string offset. */
  end: number;
};

export type EgressDisclosure = {
  sourceId: string;
  /**
   * raw: the complete protected source was sent.
   * masked: only non-sensitive original ranges survived the DLP transform.
   * partial: only originalRanges were sent without transformation.
   * derived/reference-only/none: no protected source bytes were sent.
   */
  mode: "raw" | "masked" | "partial" | "derived" | "reference-only" | "none";
  originalRanges?: OriginalTextRange[];
};

export type EgressEnvelope = {
  id: string;
  recipientId: string;
  channel: "edge-agent" | "central-llm" | "commercial-judge" | "other";
  leavesBoundary: boolean;
  /** Exact serialized contract bytes, or a documented derived safe-payload byte count. */
  payloadBytes?: number;
  byteSource?: "measured-contract" | "derived-safe-payload";
  disclosures: EgressDisclosure[];
};

export type SensitiveOccurrence = {
  kind: "resident-registration-number" | "mobile-phone" | "email" | "private-ip";
  start: number;
  end: number;
  utf8Bytes: number;
};

export type PrivacyRiskBreakdownV2 = {
  privacyRiskVersion: typeof PRIVACY_RISK_VERSION;
  score: number;
  sensitiveDetectedCount: number;
  sensitiveTransmittedCount: number;
  sensitiveTransmissionRatio: number;
  selectedAgentCount: number;
  totalAgentCount: number;
  agentSelectionRatio: number;
  originalBytes: number;
  transmittedOriginalBytes: number;
  originalDisclosureRatio: number;
  rawDataLeavesEdge: boolean;
  egressEnvelopeCount: number;
  recipientCount: number;
  privacyPass: boolean;
  outputLeak: boolean;
  diagnostics: string[];
};

const encoder = new TextEncoder();
const sensitivePatterns: Array<{
  kind: SensitiveOccurrence["kind"];
  source: string;
  flags: string;
}> = [
  { kind: "resident-registration-number", source: String.raw`\b\d{6}-?[1-4]\d{6}\b`, flags: "g" },
  { kind: "mobile-phone", source: String.raw`\b01[016789]-?\d{3,4}-?\d{4}\b`, flags: "g" },
  { kind: "email", source: String.raw`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`, flags: "gi" },
  { kind: "private-ip", source: String.raw`\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b`, flags: "g" },
];

function utf8Bytes(text: string) {
  return encoder.encode(text).length;
}

export function detectSensitiveOccurrences(text: string): SensitiveOccurrence[] {
  const occurrences: SensitiveOccurrence[] = [];
  for (const pattern of sensitivePatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      const value = match[0] ?? "";
      occurrences.push({
        kind: pattern.kind,
        start,
        end: start + value.length,
        utf8Bytes: utf8Bytes(value),
      });
    }
  }
  return occurrences.sort((left, right) => left.start - right.start || left.end - right.end);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function normalizeRange(text: string, range: OriginalTextRange): OriginalTextRange | null {
  let start = Math.floor(clamp(range.start, 0, text.length));
  let end = Math.floor(clamp(range.end, 0, text.length));
  if (end < start) [start, end] = [end, start];
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/u.test(text[start])) start -= 1;
  if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end += 1;
  return end > start ? { start, end } : null;
}

function mergeRanges(text: string, ranges: OriginalTextRange[]) {
  const normalized = ranges
    .map((range) => normalizeRange(text, range))
    .filter((range): range is OriginalTextRange => range !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: OriginalTextRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function complementRanges(text: string, excluded: OriginalTextRange[]) {
  const ranges: OriginalTextRange[] = [];
  let cursor = 0;
  for (const range of mergeRanges(text, excluded)) {
    if (range.start > cursor) ranges.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) ranges.push({ start: cursor, end: text.length });
  return ranges;
}

function disclosedRangesFor(
  source: ProtectedSource,
  disclosure: EgressDisclosure,
  occurrences: SensitiveOccurrence[],
) {
  if (disclosure.mode === "raw") return [{ start: 0, end: source.text.length }];
  if (disclosure.mode === "masked") {
    return complementRanges(source.text, occurrences.map(({ start, end }) => ({ start, end })));
  }
  if (disclosure.mode === "partial") return disclosure.originalRanges ?? [];
  return [];
}

function bytesForRanges(text: string, ranges: OriginalTextRange[]) {
  return mergeRanges(text, ranges).reduce(
    (total, range) => total + utf8Bytes(text.slice(range.start, range.end)),
    0,
  );
}

function exposedBytesForOccurrence(
  text: string,
  occurrence: SensitiveOccurrence,
  disclosedRanges: OriginalTextRange[],
) {
  const intersections = disclosedRanges.flatMap((range) => {
    const start = Math.max(range.start, occurrence.start);
    const end = Math.min(range.end, occurrence.end);
    return end > start ? [{ start, end }] : [];
  });
  return bytesForRanges(text, intersections);
}

function ratio(
  numerator: number,
  denominator: number,
  label: string,
  diagnostics: string[],
) {
  if (denominator <= 0) {
    if (numerator <= 0) return 0;
    diagnostics.push(`${label}: positive numerator with a zero denominator; clamped to 1`);
    return 1;
  }
  if (numerator < 0 || numerator > denominator) {
    diagnostics.push(`${label}: out-of-range numerator; ratio clamped to [0, 1]`);
  }
  return clamp(numerator / denominator, 0, 1);
}

function precision(value: number) {
  return Number(clamp(value, 0, 1).toFixed(6));
}

export function calculatePrivacyRiskScoreV2(input: {
  sensitiveTransmissionRatio: number;
  agentSelectionRatio: number;
  originalDisclosureRatio: number;
}) {
  return Math.round(clamp(100 * (
    0.5 * clamp(input.sensitiveTransmissionRatio, 0, 1) +
    0.3 * clamp(input.agentSelectionRatio, 0, 1) +
    0.2 * clamp(input.originalDisclosureRatio, 0, 1)
  ), 0, 100));
}

export function calculatePrivacyRiskV2(input: {
  protectedSources: ProtectedSource[];
  egressEnvelopes: EgressEnvelope[];
  selectedAgentIds: string[];
  totalAgentCount: number;
  outputTexts?: string[];
}): PrivacyRiskBreakdownV2 {
  const diagnostics: string[] = [];
  const sources = new Map<string, ProtectedSource>();
  for (const source of input.protectedSources) {
    if (sources.has(source.id)) diagnostics.push(`duplicate protected source ignored: ${source.id}`);
    else sources.set(source.id, source);
  }

  const occurrencesBySource = new Map<string, SensitiveOccurrence[]>();
  const disclosedBySource = new Map<string, OriginalTextRange[]>();
  const boundaryEnvelopes = input.egressEnvelopes.filter((envelope) => envelope.leavesBoundary);
  for (const source of sources.values()) {
    occurrencesBySource.set(source.id, detectSensitiveOccurrences(source.text));
    disclosedBySource.set(source.id, []);
  }
  for (const envelope of boundaryEnvelopes) {
    for (const disclosure of envelope.disclosures) {
      const source = sources.get(disclosure.sourceId);
      if (!source) {
        diagnostics.push(`unknown protected source in egress envelope: ${disclosure.sourceId}`);
        continue;
      }
      const occurrences = occurrencesBySource.get(source.id) ?? [];
      disclosedBySource.get(source.id)?.push(...disclosedRangesFor(source, disclosure, occurrences));
    }
  }

  let originalBytes = 0;
  let transmittedOriginalBytes = 0;
  let sensitiveDetectedCount = 0;
  let sensitiveTransmittedCount = 0;
  for (const source of sources.values()) {
    originalBytes += utf8Bytes(source.text);
    const disclosedRanges = mergeRanges(source.text, disclosedBySource.get(source.id) ?? []);
    transmittedOriginalBytes += bytesForRanges(source.text, disclosedRanges);
    for (const occurrence of occurrencesBySource.get(source.id) ?? []) {
      sensitiveDetectedCount += 1;
      sensitiveTransmittedCount += ratio(
        exposedBytesForOccurrence(source.text, occurrence, disclosedRanges),
        occurrence.utf8Bytes,
        `sensitive occurrence ${source.id}:${occurrence.start}-${occurrence.end}`,
        diagnostics,
      );
    }
  }

  const selectedAgentCount = new Set(input.selectedAgentIds).size;
  const totalAgentCount = Math.max(0, Math.floor(Number.isFinite(input.totalAgentCount) ? input.totalAgentCount : 0));
  const sensitiveTransmissionRatio = ratio(
    sensitiveTransmittedCount,
    sensitiveDetectedCount,
    "sensitiveTransmissionRatio",
    diagnostics,
  );
  const agentSelectionRatio = ratio(
    selectedAgentCount,
    totalAgentCount,
    "agentSelectionRatio",
    diagnostics,
  );
  const originalDisclosureRatio = ratio(
    transmittedOriginalBytes,
    originalBytes,
    "originalDisclosureRatio",
    diagnostics,
  );
  const outputLeak = (input.outputTexts ?? []).some((text) => detectSensitiveOccurrences(text).length > 0);
  const score = calculatePrivacyRiskScoreV2({
    sensitiveTransmissionRatio,
    agentSelectionRatio,
    originalDisclosureRatio,
  });

  return {
    privacyRiskVersion: PRIVACY_RISK_VERSION,
    score,
    sensitiveDetectedCount,
    sensitiveTransmittedCount: Number(sensitiveTransmittedCount.toFixed(6)),
    sensitiveTransmissionRatio: precision(sensitiveTransmissionRatio),
    selectedAgentCount,
    totalAgentCount,
    agentSelectionRatio: precision(agentSelectionRatio),
    originalBytes,
    transmittedOriginalBytes,
    originalDisclosureRatio: precision(originalDisclosureRatio),
    rawDataLeavesEdge: transmittedOriginalBytes > 0,
    egressEnvelopeCount: boundaryEnvelopes.length,
    recipientCount: new Set(boundaryEnvelopes.map((envelope) => envelope.recipientId)).size,
    privacyPass: !outputLeak,
    outputLeak,
    diagnostics: [...new Set(diagnostics)],
  };
}
