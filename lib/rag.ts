import corpus from "../data/rag-corpus.json";
import type { AgentId } from "./agent-registry";

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
  classification?: "public";
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

const queryExpansions: Record<string, string[]> = {
  개인정보: ["개인정보보호", "최소처리", "가명정보"],
  보안: ["접근통제", "정보보호", "안전조치"],
  조달: ["입찰", "계약", "발주", "디지털서비스"],
  품질: ["정확성", "완전성", "평가", "검수"],
  운영: ["SLA", "모니터링", "장애", "유지보수"],
  데이터: ["메타데이터", "표준화", "품질관리"],
  AI: ["인공지능", "생성형AI", "LLM"],
  비용: ["예산", "TCO", "운영비"],
};

function expandQuery(query: string) {
  const normalized = query.toLowerCase().normalize("NFKC");
  const expansions = Object.entries(queryExpansions)
    .filter(([term]) => normalized.includes(term.toLowerCase()))
    .flatMap(([, values]) => values);
  return `${query} ${expansions.join(" ")}`.trim();
}

function contentWords(text: string) {
  return [...new Set(
    [...tokenizer.segment(text.toLowerCase().normalize("NFKC"))]
      .filter((part) => part.isWordLike && part.segment.length > 1)
      .map((part) => part.segment),
  )];
}

const boilerplateSignals = [
  "이용안내", "찾아오시는 길", "업무추진비 공개", "누리집 열기",
  "화면크기", "인쇄하기", "저작권정책", "개인정보처리방침",
];

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

export function searchRag(
  query: string,
  agents: AgentId[],
  limit = 3,
): RagHit[] {
  const expandedQuery = expandQuery(query);
  const queryTokens = [...new Set(tokenize(expandedQuery))];
  const queryWords = contentWords(query);
  const candidates = indexed.filter((entry) => agents.includes(
    entry.document.agent,
  ));
  const k1 = 1.5;
  const b = 0.75;

  const bm25Candidates = candidates
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
      return { chunk: entry.document, score };
    })
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(limit * 12, 30));

  return bm25Candidates
    .map((result) => {
      const searchable = `${result.chunk.title} ${result.chunk.section} ${result.chunk.text}`.toLowerCase();
      const title = result.chunk.title.toLowerCase();
      const matchedWords = queryWords.filter((word) => searchable.includes(word));
      const coverage = matchedWords.length / Math.max(queryWords.length, 1);
      const titleMatches = queryWords.filter((word) => title.includes(word)).length;
      const phraseBonus = searchable.includes(query.toLowerCase()) ? 4 : 0;
      const boilerplatePenalty = boilerplateSignals.filter((signal) => searchable.includes(signal)).length * 0.7;
      return {
        ...result,
        score: result.score + coverage * 8 + titleMatches * 1.5 + phraseBonus - boilerplatePenalty,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => ({ ...result, score: Number(result.score.toFixed(2)) }));
}

export const ragStats = {
  chunks: corpus.count,
  counts: corpus.counts,
  generatedAt: corpus.generatedAt,
  algorithm: "BM25 + CPU lexical reranker",
};
