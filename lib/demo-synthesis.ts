import { groundedAnswersEnabled } from "./grounded-answer.ts";
import type { AgentId, Classification, KnowledgeChunk } from "./agent-registry";

type SynthesisAgent = {
  id: AgentId;
  evidence: Array<{ id: string; title: string; excerpt: string; classification: Classification;
    disclosure: "sanitized-preview" | "reference-only"; effectiveDate: string; section?: string; retrievalScore?: number; sourceSha256?: string; licenseReview?: string; sourceUrl?: string }>;
};
export function demoSynthesisEnabled() {
  return process.env.DEMO_PROFILE === "service" || process.env.DEMO_PROFILE === "operator";
}
/** Only previously approved public previews are factual input, never generated summaries. */
export function publicDemoSynthesis(agents: SynthesisAgent[]) {
  const evidence: KnowledgeChunk[] = [];
  const seen = new Set<string>();
  for (const agent of agents) {
    const publicEvidence = agent.evidence.filter(item => item.classification === "public" && item.disclosure === "sanitized-preview");
    for (const item of publicEvidence) {
      const key = JSON.stringify([item.sourceUrl ?? item.id, item.sourceSha256, item.effectiveDate, item.section, item.excerpt.replace(/\s+/g, " ")]);
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({ id: item.id, agent: agent.id, title: item.title, section: item.section || "Approved public source excerpt",
        text: item.excerpt, sourceType: "public", classification: "public", effectiveDate: item.effectiveDate,
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}), sourceSha256: item.sourceSha256, licenseReview: item.licenseReview, tags: ["public-edge-preview"] });
    }
  }
  const scores = new Map(agents.flatMap(a => a.evidence.map(e => [e.id, e.retrievalScore ?? 0] as const)));
  return { evidence: evidence.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)).slice(0, groundedAnswersEnabled() ? 8 : 4) };
}

/** Never invent or repair a citation: preserve only IDs actually supplied to synthesis. */
export function filterDemoSynthesisCitations(text: string, evidenceIds: ReadonlySet<string>) {
  return text.replace(/\[([^\]]+)\]/g, (citation, id: string) => evidenceIds.has(id) ? citation : "").trim();
}
