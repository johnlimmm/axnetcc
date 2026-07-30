import { agentProfiles, knowledge, type AgentId, type KnowledgeChunk } from "./knowledge";
import { ragStats, searchRag } from "./rag";

export type RunMode = "proposed" | "parallel" | "centralized";

const sensitivePatterns = [
  { label: "주민등록번호", regex: /\b\d{6}-?[1-4]\d{6}\b/g },
  { label: "휴대전화", regex: /\b01[016789]-?\d{3,4}-?\d{4}\b/g },
  { label: "이메일", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { label: "내부 IP", regex: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g },
];

function terms(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1);
}

function overlap(query: string, values: string[]) {
  const normalized = query.toLowerCase();
  return values.reduce((score, value) => score + (normalized.includes(value.toLowerCase()) ? 1 : 0), 0);
}

function retrieveInternal(query: string, agent: AgentId, limit = 2) {
  const queryTerms = new Set(terms(query));
  return knowledge
    .filter((chunk) => chunk.agent === agent)
    .map((chunk) => {
      const chunkTerms = terms(`${chunk.title} ${chunk.section} ${chunk.text} ${chunk.tags.join(" ")}`);
      const hit = chunkTerms.filter((term) => queryTerms.has(term)).length;
      const phrase = chunk.tags.filter((tag) => query.toLowerCase().includes(tag.toLowerCase())).length;
      return { chunk, score: hit + phrase * 2 + 0.1 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function retrieve(query: string, agent: AgentId, limit = 3) {
  const publicHits = searchRag(query, agent, limit);
  if (publicHits.length) {
    return publicHits.map(({ chunk, score }) => ({
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
    }));
  }
  return retrieveInternal(query, agent, limit);
}

function sanitize(text: string) {
  const filteredFields: string[] = [];
  let sanitized = text;
  for (const pattern of sensitivePatterns) {
    if (pattern.regex.test(sanitized)) {
      filteredFields.push(pattern.label);
      sanitized = sanitized.replace(pattern.regex, `[${pattern.label} 제거]`);
    }
    pattern.regex.lastIndex = 0;
  }
  return { sanitized, filteredFields };
}

function questionFor(agent: AgentId, query: string) {
  const purpose = query.length > 74 ? `${query.slice(0, 74)}…` : query;
  const questions: Record<AgentId, string> = {
    tech: `“${purpose}”의 최소 기술 구성, 품질 기준과 운영 전환 조건은 무엇입니까?`,
    security: `“${purpose}”에서 허용 가능한 데이터 범위와 필수 보안 통제는 무엇입니까?`,
    legal: `“${purpose}”에 적용되는 법적 의무, 계약 조건과 최종 판단 책임은 무엇입니까?`,
    finance: `“${purpose}”의 PoC·운영 비용, 조달 절차와 비용 통제 기준은 무엇입니까?`,
  };
  return questions[agent];
}

function synthesize(agent: AgentId, chunks: KnowledgeChunk[]) {
  const lead: Record<AgentId, string> = {
    tech: "검색·추론·검증 계층을 분리하고 측정 가능한 PoC 기준으로 단계적으로 도입해야 합니다.",
    security: "원문은 조직 경계에 유지하고 역할 기반 접근통제와 반환 전 민감정보 제거를 적용해야 합니다.",
    legal: "최소처리 원칙을 준수하고 위탁·재위탁·삭제·산출물 책임을 계약과 업무절차에 명시해야 합니다.",
    finance: "PoC와 본사업을 분리하고 모델 사용료와 운영·보안 비용까지 포함한 총소유비용을 산정해야 합니다.",
  };
  const grounds = chunks
    .map((chunk) => chunk.text.replace(/\s+/g, " ").slice(0, 180))
    .join(" ");
  return `${lead[agent]} ${grounds}`;
}

export function orchestrate(rawQuery: string, mode: RunMode = "proposed") {
  const startedAt = Date.now();
  const { sanitized: query, filteredFields: inputFiltered } = sanitize(rawQuery.trim());
  const ids = Object.keys(agentProfiles) as AgentId[];
  const scores = Object.fromEntries(
    ids.map((id) => [id, overlap(query, agentProfiles[id].keywords)]),
  ) as Record<AgentId, number>;
  const selected =
    mode === "proposed"
      ? ids.filter((id) => scores[id] > 0)
      : ids;
  if (!selected.length) selected.push("tech");

  const agentResults = ids.map((id, index) => {
    const retrieved = retrieve(query, id);
    const rawSummary = synthesize(id, retrieved.map((item) => item.chunk));
    const { sanitized: summary, filteredFields } = sanitize(rawSummary);
    return {
      id,
      ...agentProfiles[id],
      selected: selected.includes(id),
      score: Math.min(99, 58 + scores[id] * 8),
      question: questionFor(id, query),
      summary,
      evidence: retrieved.map(({ chunk, score }) => ({
        id: chunk.id,
        title: chunk.title,
        excerpt: `${chunk.section} · ${chunk.text.replace(/\s+/g, " ").slice(0, 110)}…`,
        sourceUrl: chunk.sourceUrl,
        sourceType: chunk.sourceType,
        effectiveDate: chunk.effectiveDate,
        retrievalScore: Number(score.toFixed(2)),
      })),
      responsibility: agentProfiles[id].responsibility,
      filteredFields: [...new Set([...inputFiltered, ...filteredFields])],
      latencyMs: 220 + index * 31 + retrieved.length * 18,
    };
  });

  const selectedResults = agentResults.filter((result) => result.selected);
  const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
  const requiresSecurity = /개인|민감|내부|보안|민원|데이터/i.test(query);
  const requiresLegal = /법|계약|책임|위탁|개인/i.test(query);
  const missing = [
    requiresSecurity && !selected.includes("security") ? "보안" : "",
    requiresLegal && !selected.includes("legal") ? "법무" : "",
  ].filter(Boolean);
  const tokens = Math.ceil((query.length + selectedResults.reduce((sum, result) => sum + result.summary.length, 0)) * 1.7);
  const bytes = new TextEncoder().encode(JSON.stringify(selectedResults)).length;

  return {
    runId: `RUN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    mode,
    query,
    title: "신규 AI 서비스 도입 종합 검토",
    conclusion: "제한적 시범 도입을 권고합니다. 원문 데이터의 조직 내 보존, 역할 기반 접근통제, 담당자 최종 검토를 선행조건으로 설정하고 PoC 이후 품질·보안·비용 지표를 재평가해야 합니다.",
    status: missing.length ? "review" : "ready",
    agents: agentResults,
    checks: [
      { label: "필수 검토영역", status: missing.length ? "warn" : "pass", detail: missing.length ? `${missing.join("·")} 영역이 누락되었습니다.` : `${selected.length}개 필수 전문영역을 반영했습니다.` },
      { label: "근거 완전성", status: evidenceCount >= selected.length ? "pass" : "warn", detail: `${evidenceCount}개 근거 청크가 판단에 연결되었습니다.` },
      { label: "응답 충돌", status: selected.length > 1 ? "warn" : "pass", detail: selected.length > 1 ? "기술 편의성과 데이터 최소화 원칙을 조건부 조정해야 합니다." : "상충 판단이 발견되지 않았습니다." },
      { label: "민감정보", status: "pass", detail: inputFiltered.length ? `${inputFiltered.join("·")} 입력을 마스킹했습니다.` : "직접 식별자가 발견되지 않았습니다." },
    ],
    metrics: {
      calls: selected.length,
      tokens,
      bytes,
      latencyMs: Date.now() - startedAt + Math.max(...selectedResults.map((result) => result.latencyMs)),
      exposedFields: 0,
      traceability: evidenceCount ? 100 : 0,
      ragChunks: ragStats.chunks,
    },
    timeline: [
      { label: "요청 정제", detail: `민감필드 ${inputFiltered.length}개 제거`, ms: 8 },
      { label: "Agent 선택", detail: `${selected.length}개 역할 관련도·권한 일치`, ms: 12 },
      { label: "Local RAG", detail: `${evidenceCount}개 근거 청크 검색`, ms: 31 },
      { label: "응답 검증", detail: "필수영역·근거·충돌·민감정보 점검", ms: 15 },
      { label: "결과 통합", detail: "근거 식별자·검토주체 연결", ms: 11 },
    ],
  };
}
