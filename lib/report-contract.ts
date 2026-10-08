import type { AgentId } from "./agent-registry";

export type ReportPriority = "high" | "medium" | "low";

export type ReportFinding = {
  title: string;
  content: string;
  citations: string[];
};

export type ReportRecommendation = {
  content: string;
  priority: ReportPriority;
  citations: string[];
};

export type AgentEvidenceReport = {
  version: "1";
  title: string;
  executiveSummary: string;
  findings: ReportFinding[];
  recommendations: ReportRecommendation[];
  limitations: string[];
  citationIds: string[];
};

export type IntegratedReportSection = ReportFinding & {
  sourceAgentIds: AgentId[];
};

export type IntegratedEvidenceReport = {
  version: "1";
  title: string;
  executiveSummary: string;
  primaryAgentId: AgentId;
  participatingAgentIds: AgentId[];
  sections: IntegratedReportSection[];
  recommendations: ReportRecommendation[];
  limitations: string[];
  references: Array<{ evidenceId: string; agentId: AgentId }>;
};

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function sentences(text: string) {
  return text
    .split(/\n+|(?<=[.!?다요])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function citationsIn(text: string, allowedIds: string[]) {
  const allowed = new Set(allowedIds);
  return unique(
    [...text.matchAll(/\[([^\]]+)\]/g)]
      .map((match) => match[1])
      .filter((id) => allowed.has(id)),
  );
}

function withCitation(text: string, citationIds: string[]) {
  const allowed = new Set(citationIds);
  const cleaned = text
    .replace(/\[([^\]]+)\]/g, (citation, id: string) => allowed.has(id) ? citation : "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned || !citationIds.length || citationsIn(cleaned, citationIds).length) return cleaned;
  return `${cleaned} [${citationIds[0]}]`;
}

function cleanUnsupportedCitations(text: string, citationIds: string[]) {
  const allowed = new Set(citationIds);
  return text
    .replace(/\[([^\]]+)\]/g, (citation, id: string) => allowed.has(id) ? citation : "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function reportPriority(index: number): ReportPriority {
  return index === 0 ? "high" : index === 1 ? "medium" : "low";
}

/**
 * Builds a stable report contract from the Edge-local LLM answer. The answer
 * may be free text, but every report citation is restricted to evidence that
 * the same Agent actually retrieved.
 */
export function buildAgentEvidenceReport(input: {
  grounded?: boolean;
  agentId: AgentId;
  agentName: string;
  responsibility: string;
  executionRole: "primary" | "required-reviewer" | "supporting";
  summary: string;
  evidenceIds: string[];
  evidenceTitles?: Array<{ id: string; title: string }>;
}): AgentEvidenceReport {
  const evidenceIds = unique(input.evidenceIds);
  if (input.grounded) {
    const content = cleanUnsupportedCitations(input.summary, evidenceIds);
    const citations = citationsIn(content, evidenceIds);
    return { version: "1", title: `${input.agentName} public evidence`, executiveSummary: content,
      findings: [{ title: "Public-source answer", content, citations }],
      recommendations: [], limitations: ["Source citation membership does not establish semantic support or organizational compliance."], citationIds: citations };
  }
  const rawSentences = sentences(input.summary);
  const usefulSentences = rawSentences.length ? rawSentences : ["확인 가능한 검토 의견이 없습니다."];
  const findings = usefulSentences.slice(0, 3).map((sentence, index) => {
    const fallbackId = evidenceIds[index] ?? evidenceIds[0];
    const content = withCitation(sentence, fallbackId ? [fallbackId] : []);
    return {
      title: index === 0 ? "핵심 판단" : `세부 검토 ${index}`,
      content,
      citations: citationsIn(content, evidenceIds),
    };
  });
  const cited = unique(findings.flatMap((finding) => finding.citations));
  const uncited = evidenceIds.filter((id) => !cited.includes(id));
  for (const [index, evidenceId] of uncited.slice(0, 2).entries()) {
    const title = input.evidenceTitles?.find((item) => item.id === evidenceId)?.title ?? "RAG 검색 근거";
    findings.push({
      title: `추가 근거 ${index + 1}`,
      content: `${title}을 추가 검토 근거로 확인했습니다. [${evidenceId}]`,
      citations: [evidenceId],
    });
  }
  const recommendationSeed = input.executionRole === "primary"
    ? "주관 부서는 아래 근거를 기준으로 실행 범위와 승인 조건을 확정해야 합니다."
    : "협력 부서는 아래 근거와 관련된 필수 통제를 주관 부서의 실행계획에 반영해야 합니다.";
  const recommendationCitations = findings[0]?.citations.length
    ? findings[0].citations
    : evidenceIds.slice(0, 1);
  const recommendation = withCitation(recommendationSeed, recommendationCitations);
  return {
    version: "1",
    title: `${input.agentName} 근거 기반 검토보고서`,
    executiveSummary: cleanUnsupportedCitations(usefulSentences.slice(0, 2).join(" "), evidenceIds),
    findings,
    recommendations: [{
      content: recommendation,
      priority: reportPriority(0),
      citations: citationsIn(recommendation, evidenceIds),
    }],
    limitations: evidenceIds.length
      ? ["보고서는 Agent의 권한 범위에서 검색된 RAG 근거와 안전 요약만 사용했습니다."]
      : ["검증 가능한 RAG 근거가 없어 사람의 추가 확인이 필요합니다."],
    citationIds: unique(findings.flatMap((finding) => finding.citations)),
  };
}

export function buildIntegratedEvidenceReport(input: {
  grounded?: boolean;
  preserveConclusionCitations?: boolean;
  title: string;
  conclusion: string;
  primaryAgentId: AgentId;
  agents: Array<{
    id: AgentId;
    report: AgentEvidenceReport;
    evidenceIds: string[];
  }>;
}): IntegratedEvidenceReport {
  const participatingAgentIds = unique(input.agents.map((agent) => agent.id)) as AgentId[];
  const evidenceOwner = new Map<string, AgentId>();
  for (const agent of input.agents) {
    for (const evidenceId of agent.evidenceIds) evidenceOwner.set(evidenceId, agent.id);
  }
  const allEvidenceIds = [...evidenceOwner.keys()];
  const sections: IntegratedReportSection[] = input.agents.map((agent) => {
    const finding = agent.report.findings[0];
    const content = finding?.content || agent.report.executiveSummary;
    const citations = citationsIn(content, agent.evidenceIds);
    return {
      title: agent.id === input.primaryAgentId
        ? "주관 Agent 종합 판단"
        : `${agent.report.title.replace(" 근거 기반 검토보고서", "")} 협력 검토`,
      content,
      citations,
      sourceAgentIds: [agent.id],
    };
  });
  const conclusionCitations = citationsIn(input.conclusion, allEvidenceIds);
  sections.unshift({
    title: "중앙 통합 결론",
    content: input.preserveConclusionCitations
      ? cleanUnsupportedCitations(input.conclusion, allEvidenceIds)
      : withCitation(input.conclusion, conclusionCitations.length ? conclusionCitations : allEvidenceIds.slice(0, 1)),
    citations: input.preserveConclusionCitations
      ? conclusionCitations
      : conclusionCitations.length ? conclusionCitations : allEvidenceIds.slice(0, 1),
    sourceAgentIds: participatingAgentIds,
  });
  const recommendations = input.agents.flatMap((agent) =>
    agent.report.recommendations.map((recommendation) => ({
      ...recommendation,
      citations: recommendation.citations.filter((id) => agent.evidenceIds.includes(id)),
    })),
  );
  return {
    version: "1",
    title: input.title,
    executiveSummary: cleanUnsupportedCitations(input.conclusion, allEvidenceIds),
    primaryAgentId: input.primaryAgentId,
    participatingAgentIds,
    sections,
    recommendations: input.grounded ? [] : recommendations,
    limitations: unique(input.agents.flatMap((agent) => agent.report.limitations)),
    references: [...evidenceOwner].map(([evidenceId, agentId]) => ({ evidenceId, agentId })),
  };
}
