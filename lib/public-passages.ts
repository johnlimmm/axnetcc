import type { AgentId } from "./agent-registry";

export type PublicDocument = {
  id: string; agent: AgentId; title: string; section: string; text: string;
  sourceUrl?: string; publishedAt?: string | null; sourceSha256: string;
  licenseReview: string; classification?: "public";
};
export type PublicPassage = { text: string; start: number; end: number };
export type PublicRagHit = {
  chunk: PublicDocument; score: number; passage: PublicPassage;
  agents: AgentId[]; sourceIds: string[];
};

/** Shared lexical guard, not a claim of complete semantic qualifier detection. */
export function isPublicQualifier(text: string) {
  return /^\s*(?:※|\*)/u.test(text) || /^(?:[\s\-•·※*○●■⬛◈・]+)?(?:다만|단[ ,:：]|예외|그러나|이 경우|해당 경우|경우|이때|그렇지만|하지만|단서|unless\b|except\b|however\b|provided\b|nevertheless\b|exceptions?\b|only\b|otherwise\b)/iu.test(text);
}

const segmenter = new Intl.Segmenter("ko", { granularity: "word" });
export function publicQueryTerms(query: string) {
  return [...new Set([...segmenter.segment(query.toLowerCase().normalize("NFKC"))]
    .filter(part => part.isWordLike && part.segment.length > 1)
    .map(part => part.segment.replace(/(에서는|에서|으로|에게|은|는|을|를|의|과|와)$/u, ""))
    .filter(word => word.length > 1 && !/^(설명|알려|어떻게|무엇|각각|관점|중심|비교|따라)$/u.test(word)))];
}

function bodyCoverage(query: string, text: string) {
  const words = publicQueryTerms(query);
  const normalized = text.toLowerCase().normalize("NFKC").replace(/\s+/gu, "");
  return words.filter(word => normalized.includes(word)).length / Math.max(1, words.length);
}

/** Preserve numeric date/list punctuation and PDF soft wraps; never rewrite source text. */
export function publicSentenceUnits(text: string): string[] {
  const boundaries = new Set([0, text.length]);
  for (const match of text.matchAll(/[.!?。！？](?=\s)/gu)) {
    if (match[0] === "." && /\p{N}/u.test(text[match.index - 1] ?? "")) continue;
    boundaries.add(match.index + 1);
  }
  // Explicit list-entry markers are structural boundaries; ordinary wrapped
  // lines (including a date's following month) remain part of the same unit.
  for (const match of text.matchAll(/\n(?=[ \t]*(?:[○●■⬛◈※①-⑳]|[-•・*][ \t]+|(?:\d+\.){2,}[ \t]+))/gu)) {
    boundaries.add(match.index + 1);
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  return ordered.slice(1).map((end, index) => text.slice(ordered[index], end));
}

/** A contiguous, attributable excerpt: no chopped sentences or rewritten qualifications. */
export function selectPublicPassage(query: string, text: string, maxChars = 1200): PublicPassage {
  if (text.length <= maxChars) return { text, start: 0, end: text.length };
  // PDF extraction inserts soft line wraps inside conditions. A newline alone
  // is not a sentence boundary: an overbudget unsplit statement must be omitted,
  // rather than displaying its premise without the following qualification.
  const sentences: PublicPassage[] = [];
  let offset = 0;
  for (const unit of publicSentenceUnits(text)) {
    const previous = sentences.at(-1);
    if (previous && (!unit.trim() || isPublicQualifier(unit))) {
      previous.text += unit;
      previous.end += unit.length;
    } else {
      sentences.push({ text: unit, start: offset, end: offset + unit.length });
    }
    offset += unit.length;
  }
  const words = publicQueryTerms(query);
  const matches = sentences.map(sentence => {
    const normalized = sentence.text.toLowerCase().normalize("NFKC").replace(/\s+/gu, "");
    return words.filter(word => normalized.includes(word));
  });
  let best: PublicPassage = { text: "", start: 0, end: 0 };
  let bestScore = 0;
  // Compare complete contiguous windows, not a single winning sentence followed
  // by forward filler. Qualifier chains are already indivisible units above.
  for (let first = 0; first < sentences.length; first++) {
    const covered = new Set<string>();
    for (let last = first; last < sentences.length; last++) {
      const start = sentences[first].start;
      const end = sentences[last].end;
      if (end - start > maxChars) break;
      for (const word of matches[last]) covered.add(word);
      if (covered.size > bestScore || (covered.size > 0 && covered.size === bestScore &&
        start === best.start && end > best.end)) {
        bestScore = covered.size;
        best = { text: text.slice(start, end), start, end };
      }
    }
  }
  return best;
}

function usablePublicBody(chunk: PublicDocument) {
  // The existing corpus's `document` records include listings, search XML and navigation.
  // Until individually reviewed, only extracted, source-hashed PDF page bodies qualify.
  if (!/^page:\d+$/.test(chunk.section) || !chunk.sourceUrl || !chunk.sourceSha256) return false;
  if (!/^https?:\/\//i.test(chunk.sourceUrl) || /lawSearch\.do|ListBusiness\.do|bbsList\.do/i.test(chunk.sourceUrl)) return false;
  if (/^\s*(?:[-\d\s]*)(?:CONTENTS\b|목\s*차(?=[^\p{L}]|$))/iu.test(chunk.text) || /<LawSearch>|<법령목록>/u.test(chunk.text)) return false;
  if (chunk.text.trim().length < 40) return false;
  return true;
}

/** Deduplicate role copies, never distinct source versions or page contexts. */
export function selectPublicHits(query: string, hits: { chunk: PublicDocument; score: number }[], limit = 3,
  documents: PublicDocument[] = hits.map(hit => hit.chunk)): PublicRagHit[] {
  const unique = new Map<string, PublicRagHit>();
  const pages = new Map<string, PublicDocument[]>();
  const pageKey = (chunk: PublicDocument) => JSON.stringify([chunk.sourceUrl, chunk.sourceSha256,
    chunk.publishedAt ?? null, chunk.section, chunk.agent]);
  for (const chunk of documents) {
    const key = pageKey(chunk);
    const page = pages.get(key) ?? [];
    page.push(chunk);
    pages.set(key, page);
  }
  for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
    if (!usablePublicBody(hit.chunk)) continue;
    const page = [...(pages.get(pageKey(hit.chunk)) ?? [hit.chunk])]
      .sort((a, b) => Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
    let text = page[0].text;
    let contiguous = true;
    for (const next of page.slice(1)) {
      if (text === next.text) continue;
      let overlap = Math.min(text.length, next.text.length);
      while (overlap >= 32 && !text.endsWith(next.text.slice(0, overlap))) overlap--;
      if (overlap < 32) { contiguous = false; break; }
      text += next.text.slice(overlap);
    }
    const chunk = contiguous ? { ...hit.chunk, text } : hit.chunk;
    if (!usablePublicBody(chunk)) continue;
    const sourceIds = contiguous ? page.map(item => item.id) : [hit.chunk.id];
    const key = JSON.stringify([hit.chunk.sourceUrl, hit.chunk.sourceSha256, hit.chunk.publishedAt ?? null,
      hit.chunk.section, chunk.text.normalize("NFKC").replace(/\s+/gu, " ").trim()]);
    const existing = unique.get(key);
    if (existing) {
      if (!existing.agents.includes(hit.chunk.agent)) existing.agents.push(hit.chunk.agent);
      for (const id of sourceIds) if (!existing.sourceIds.includes(id)) existing.sourceIds.push(id);
      continue;
    }
    const passage = selectPublicPassage(query, chunk.text);
    if (!passage.text) continue;
    unique.set(key, { ...hit, chunk, passage, agents: [hit.chunk.agent], sourceIds });
  }
  // Re-score the restored page rather than its arbitrarily cut ingestion chunk.
  // Coverage favors multiple requested concepts over repetition of one term.
  return [...unique.values()].map(hit => ({ ...hit,
    score: Number((hit.score + 60 * bodyCoverage(query, hit.chunk.text)).toFixed(2)),
  })).sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}
