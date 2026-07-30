import corpus from "../data/rag-corpus.json";
import type { AgentId } from "./knowledge";

type CorpusDocument = {
  id: string;
  agent: AgentId;
  title: string;
  section: string;
  text: string;
  sourceUrl?: string;
  publishedAt?: string | null;
  sourceSha256: string;
  licenseReview: string;
};

const documents = corpus.documents as CorpusDocument[];
const tokenizer = new Intl.Segmenter("ko", { granularity: "word" });

function tokenize(text: string) {
  const normalized = text.toLowerCase().normalize("NFKC");
  const words = [...tokenizer.segment(normalized)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
    .filter((word) => word.length > 1);
  const compact = normalized.replace(/[^\p{L}\p{N}]/gu, "");
  const bigrams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) =>
    compact.slice(index, index + 2),
  );
  return [...words, ...bigrams];
}

const indexed = documents.map((document) => {
  const tokens = tokenize(`${document.title} ${document.section} ${document.text}`);
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return { document, frequencies, length: tokens.length };
});

const documentFrequency = new Map<string, number>();
for (const entry of indexed) {
  for (const token of entry.frequencies.keys()) {
    documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
}
const averageLength = indexed.reduce((sum, entry) => sum + entry.length, 0) / indexed.length;

export type RagHit = {
  chunk: CorpusDocument;
  score: number;
};

export function searchRag(query: string, agent: AgentId, limit = 3): RagHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  const candidates = indexed.filter((entry) => entry.document.agent === agent);
  const k1 = 1.5;
  const b = 0.75;

  return candidates
    .map((entry) => {
      let score = 0;
      for (const token of queryTokens) {
        const frequency = entry.frequencies.get(token) ?? 0;
        if (!frequency) continue;
        const frequencyInCorpus = documentFrequency.get(token) ?? 0;
        const inverseDocumentFrequency = Math.log(
          1 + (indexed.length - frequencyInCorpus + 0.5) / (frequencyInCorpus + 0.5),
        );
        score +=
          inverseDocumentFrequency *
          ((frequency * (k1 + 1)) /
            (frequency + k1 * (1 - b + b * (entry.length / averageLength))));
      }
      if (entry.document.title.includes(query)) score += 4;
      return { chunk: entry.document, score };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => ({ ...result, score: Number(result.score.toFixed(2)) }));
}

export const ragStats = {
  chunks: corpus.count,
  counts: corpus.counts,
  generatedAt: corpus.generatedAt,
  algorithm: corpus.algorithm,
};

