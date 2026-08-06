import corpus from "../../../../data/rag-corpus.json";
import scenarios from "../../../../emulation/scenarios.json";
import securityManifest from "../../../../data/security-evidence-manifest.json";
import { planEvidence, type EvidenceCandidate, type EvidenceStrategy } from "../../../../lib/evidence-acquisition";
import { searchRag } from "../../../../lib/rag";
import { knowledge, type AgentId } from "../../../../lib/knowledge";

const roles = ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"] as const;

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.query !== "string" || body.query.trim().length < 5) return Response.json({ error: "query must contain at least 5 characters" }, { status: 400 });
    const selectedRoles: AgentId[] = Array.isArray(body.selectedRoles) ? body.selectedRoles.filter((role): role is AgentId => typeof role === "string" && roles.includes(role as AgentId)) : ["tech"];
    const requiredConcepts = Array.isArray(body.requiredConcepts) ? body.requiredConcepts.filter((item): item is string => typeof item === "string") : [];
    const documents = corpus.documents as Array<{ id: string; agent: AgentId; title: string; section: string; text: string; sourceSha256: string; publishedAt?: string }>;
    const candidateEvidenceByRole: Partial<Record<AgentId, EvidenceCandidate[]>> = Object.fromEntries(selectedRoles.map((role) => [role, [
      ...knowledge.filter((item) => item.agent === role).map((item) => ({ id: item.id, canonicalId: `local:${item.id}`, title: item.title, section: item.section, ownerDepartment: role, securityLevel: item.classification, effectiveDate: item.effectiveDate, text: item.text, requiredConcepts, conceptAliases: securityManifest.conceptAliases } satisfies EvidenceCandidate)),
      ...searchRag(body.query as string, [role], 2).map(({ chunk }) => {
      const source = documents.find((document) => document.id === chunk.id)!;
      return { id: source.id, canonicalId: source.sourceSha256, title: source.title, section: source.section, ownerDepartment: role, securityLevel: "public", effectiveDate: source.publishedAt ?? "unknown", text: source.text, requiredConcepts, conceptAliases: securityManifest.conceptAliases } satisfies EvidenceCandidate;
    })]]));
    const scenarioName = typeof body.networkScenario === "string" && body.networkScenario in scenarios ? body.networkScenario as keyof typeof scenarios : "normal";
    const strategy: EvidenceStrategy = body.evidenceStrategy === "axnetcc-saea" ? "axnetcc-saea" : "legacy";
    return Response.json(planEvidence({ query: body.query, selectedRoles, candidateEvidenceByRole, strategy, networkScenario: { name: scenarioName, ...scenarios[scenarioName] }, requesterZone: typeof body.requesterZone === "string" ? body.requesterZone : "core" }));
  } catch {
    return Response.json({ error: "invalid JSON request" }, { status: 400 });
  }
}
