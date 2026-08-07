import { agentProfiles, type AgentId, type Classification, type KnowledgeChunk } from "./agent-registry";
import {
  EDGE_AGENT_CONTRACT_VERSION,
  validateEdgeAgentRequest,
  validateEdgeAgentResponse,
  type EdgeAgentRequest,
  type EdgeAgentResponse,
  type EdgeEvidenceReference,
} from "./edge-agent-contract";
import { sanitizeSensitiveText } from "./data-loss-prevention";
import { planEvidenceAtEdge } from "./evidence-acquisition";
import { resolveConceptsForAgent } from "./boundary-router";
import { knowledge } from "./knowledge";
import { generateLocalAnswer } from "./local-llm";
import { ragStats, searchRag } from "./rag";

const POLICY_VERSION = "edge-rag-v1";
const classificationRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

type RankedChunk = { chunk: KnowledgeChunk; score: number };

function queryTerms(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

function internalScore(query: string, chunk: KnowledgeChunk) {
  const terms = queryTerms(query);
  const searchable = `${chunk.title} ${chunk.section} ${chunk.text} ${chunk.tags.join(" ")}`
    .toLowerCase()
    .normalize("NFKC");
  const tokenHits = terms.filter((term) => searchable.includes(term)).length;
  const tagHits = chunk.tags.filter((tag) => query.toLowerCase().includes(tag.toLowerCase())).length;
  return tokenHits * 18 + tagHits * 30 + (tokenHits ? 5 : 0);
}

function maxClassification(classes: Classification[]) {
  return classes.reduce<Classification>(
    (highest, item) => classificationRank[item] > classificationRank[highest] ? item : highest,
    "public",
  );
}

function effectiveClasses(request: EdgeAgentRequest) {
  const allowed = agentProfiles[request.agentId].allowedClasses;
  if (!request.requestedMaxClassification) return [...allowed];
  const ceiling = classificationRank[request.requestedMaxClassification];
  return allowed.filter((item) => classificationRank[item] <= ceiling);
}

function retrieveAtEdge(request: EdgeAgentRequest) {
  const profile = agentProfiles[request.agentId];
  const ragAgents = profile.ragAgents as readonly AgentId[];
  const allowedClasses = effectiveClasses(request);
  const scopedInternal = knowledge.filter((chunk) => ragAgents.includes(chunk.agent));
  const blockedCount = scopedInternal.filter(
    (chunk) => !allowedClasses.includes(chunk.classification),
  ).length;

  // 등급을 먼저 제거한 뒤 허용된 문서에 대해서만 점수를 계산한다.
  const internal = scopedInternal
    .filter((chunk) => allowedClasses.includes(chunk.classification))
    .map((chunk) => ({ chunk, score: internalScore(request.minimalQuery, chunk) }))
    .filter((item) => item.score > 0);

  const publicHits = allowedClasses.includes("public")
    ? searchRag(request.minimalQuery, [...ragAgents], Math.min(request.limits.topK * 4, 10))
      .map(({ chunk, score }) => ({
        score,
        chunk: {
          id: chunk.id,
          agent: chunk.agent,
          title: chunk.title,
          section: chunk.section,
          text: chunk.text,
          sourceType: "public" as const,
          classification: "public" as const,
          effectiveDate: chunk.publishedAt ?? "발행일 미상",
          sourceUrl: chunk.sourceUrl,
          tags: [],
        },
      }))
    : [];

  const ranked = [...internal, ...publicHits]
    .sort((left, right) => right.score - left.score)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.chunk.id === item.chunk.id) === index)
    .slice(0, request.limits.topK);
  return { ranked, allowedClasses, blockedCount };
}

function deterministicSummary(agentId: EdgeAgentRequest["agentId"], ranked: RankedChunk[]) {
  const citations = ranked.map((item) => `[${item.chunk.id}]`).join(" ");
  const intro = ranked.length
    ? `${agentProfiles[agentId].shortName} 관점에서 허용된 근거 ${ranked.length}건을 확인했습니다.`
    : `${agentProfiles[agentId].shortName} 관점에서 현재 권한으로 확인 가능한 근거가 부족합니다.`;
  return `판단: ${intro} ${citations}`.trim();
}

function enforceCitations(text: string, evidenceIds: string[]) {
  if (!evidenceIds.length) return text.replace(/\[[^\]]+\]/g, "").trim();
  const valid = new Set(evidenceIds);
  const cleaned = text.replace(/\[([^\]]+)\]/g, (citation, id: string) => valid.has(id) ? citation : "");
  return evidenceIds.some((id) => cleaned.includes(`[${id}]`))
    ? cleaned.trim()
    : `${cleaned.trim()} [${evidenceIds[0]}]`;
}

function evidenceForEgress(ranked: RankedChunk[]) {
  const filteredFields: string[] = [];
  const evidence = ranked.map<EdgeEvidenceReference>(({ chunk, score }) => {
    if (chunk.classification !== "public") {
      return {
        referenceId: chunk.id,
        classification: chunk.classification,
        disclosure: "reference-only",
      };
    }
    const title = sanitizeSensitiveText(chunk.title);
    const excerpt = sanitizeSensitiveText(`${chunk.section} · ${chunk.text.replace(/\s+/g, " ").slice(0, 160)}`);
    filteredFields.push(...title.filteredFields, ...excerpt.filteredFields);
    return {
      referenceId: chunk.id,
      classification: "public",
      disclosure: "excerpt",
      title: title.sanitized || "공개 근거",
      section: sanitizeSensitiveText(chunk.section).sanitized || "공개 문서",
      excerpt: excerpt.sanitized || "공개 근거의 안전한 미리보기입니다.",
      ...(chunk.sourceUrl ? { sourceUrl: chunk.sourceUrl } : {}),
      retrievalScore: Number(score.toFixed(2)),
    };
  });
  return { evidence, filteredFields };
}

function mergeSignals(signal: AbortSignal | undefined, deadlineMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(new DOMException("Edge deadline exceeded", "TimeoutError")), deadlineMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function updatePayloadSize(response: EdgeAgentResponse) {
  const encoder = new TextEncoder();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = encoder.encode(JSON.stringify(response)).length;
    if (response.metrics.egressBytes === bytes && response.boundary.returnedBytes === bytes) {
      return;
    }
    response.metrics.egressBytes = bytes;
    response.boundary.returnedBytes = bytes;
  }
  throw new Error("Edge response size did not converge");
}

/**
 * Edge 전용 서비스다. 이 파일만 corpus와 내부 knowledge를 import하며 Core는 client 계약만 사용한다.
 */
export async function executeEdgeAgentLocally(
  untrustedRequest: unknown,
  signal?: AbortSignal,
): Promise<EdgeAgentResponse> {
  const validatedRequest = validateEdgeAgentRequest(untrustedRequest);
  const querySanitization = sanitizeSensitiveText(validatedRequest.minimalQuery);
  const request: EdgeAgentRequest = {
    ...validatedRequest,
    minimalQuery: querySanitization.sanitized,
  };
  const startedAt = performance.now();
  const deadline = mergeSignals(signal, request.limits.deadlineMs);
  try {
    const { ranked, allowedClasses, blockedCount } = retrieveAtEdge(request);
    const evidencePlan = request.evidenceRequirements
      ? planEvidenceAtEdge({
          agentId: request.agentId,
          ranked,
          requiredConcepts: resolveConceptsForAgent(
            request.evidenceRequirements.requiredConceptIds,
            request.agentId,
          ),
        })
      : undefined;
    const rawEvidence = ranked.map((item) => item.chunk);
    const sourceBytesProcessed = new TextEncoder().encode(JSON.stringify(rawEvidence)).length;
    const evidenceIds = rawEvidence.map((item) => item.id);
    const returnedClasses = [...new Set(rawEvidence.map((item) => item.classification))];
    const highest = returnedClasses.length ? maxClassification(returnedClasses) : "public";
    const hasConfidentialEvidence = highest === "confidential";
    const fallback = deterministicSummary(request.agentId, ranked);
    const generated = request.purpose === "benchmark" || hasConfidentialEvidence
      ? {
          text: fallback,
          metrics: {
            backend: "deterministic" as const,
            model: request.purpose === "benchmark" ? "edge-evidence-map" : "edge-restricted-reference",
            ttftMs: null,
            tpotMs: null,
            tokensPerSecond: null,
            promptTokens: null,
            completionTokens: null,
            totalMs: 0,
            fallbackReason: hasConfidentialEvidence
              ? "Confidential evidence remains inside the Edge boundary"
              : "Benchmark mode returns evidence mapping only",
          },
        }
      : await generateLocalAnswer({
          agent: request.agentId,
          agentName: agentProfiles[request.agentId].name,
          responsibility: agentProfiles[request.agentId].responsibility,
          query: request.minimalQuery,
          evidence: rawEvidence,
          fallback,
          signal: deadline.signal,
        });

    const restrictedSummary = hasConfidentialEvidence
      ? `판단: ${highest} 등급 근거가 확인되었습니다. 세부 원문은 Edge에 보존되며 권한 있는 검토가 필요합니다. ${evidenceIds.map((id) => `[${id}]`).join(" ")}`
      : generated.text;
    const sanitizedAnswer = sanitizeSensitiveText(
      enforceCitations(restrictedSummary, evidenceIds),
    );
    const egress = evidenceForEgress(ranked);
    const now = new Date().toISOString();
    const baseResponse: EdgeAgentResponse = {
      version: EDGE_AGENT_CONTRACT_VERSION,
      requestId: request.requestId,
      agentId: request.agentId,
      status: ranked.length
        ? generated.metrics.backend === "ollama" ? "completed" : "fallback"
        : "insufficient-evidence",
      answer: {
        text: sanitizedAnswer.sanitized || "허용된 범위에서 반환할 수 있는 답변이 없습니다.",
        classification: highest,
        citations: evidenceIds,
      },
      evidence: egress.evidence,
      ...(evidencePlan ? { evidencePlan } : {}),
      policy: {
        decisionId: `POL-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
        outcome: highest === "public" &&
          !querySanitization.filteredFields.length &&
          !sanitizedAnswer.filteredFields.length
          ? "allow"
          : "redact",
        effectiveClasses: allowedClasses,
        highestEvidenceClassification: ranked.length ? highest : null,
        redactionCount: querySanitization.filteredFields.length +
          sanitizedAnswer.filteredFields.length + egress.filteredFields.length +
          egress.evidence.filter((item) => item.classification !== "public").length,
        blockedCount,
      },
      metrics: {
        backend: generated.metrics.backend,
        model: generated.metrics.model,
        evidenceCount: egress.evidence.length,
        sourceBytesProcessed,
        egressBytes: 0,
        latencyMs: Math.round(performance.now() - startedAt),
        ttftMs: generated.metrics.ttftMs,
        tpotMs: generated.metrics.tpotMs,
        corpusChunks: ragStats.chunks,
      },
      boundary: {
        transport: "local",
        rawCorpusTransferred: false,
        returnedBytes: 0,
        evidencePayloadBytes: new TextEncoder().encode(JSON.stringify(egress.evidence)).length,
        restrictedEvidenceCount: egress.evidence.filter((item) => item.classification !== "public").length,
      },
      audit: {
        eventId: `AUD-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
        recordedAt: now,
        policyVersion: POLICY_VERSION,
      },
    };
    updatePayloadSize(baseResponse);
    return validateEdgeAgentResponse(baseResponse);
  } finally {
    deadline.dispose();
  }
}
