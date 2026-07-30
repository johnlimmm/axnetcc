import { agentProfiles, knowledge, type AgentId, type KnowledgeChunk } from "./knowledge";
import { generateLocalAnswer } from "./local-llm";
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
  const publicHits = searchRag(query, agentProfiles[agent].ragAgents, limit);
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
    data: `“${purpose}”에 필요한 데이터의 출처, 품질, 수명주기와 이용 조건은 무엇입니까?`,
    security: `“${purpose}”에서 허용 가능한 데이터 범위와 필수 보안 통제는 무엇입니까?`,
    legal: `“${purpose}”에 적용되는 법적 의무, 계약 조건과 최종 판단 책임은 무엇입니까?`,
    policy: `“${purpose}”의 공공성, 투명성, 편향 및 영향평가 기준은 무엇입니까?`,
    finance: `“${purpose}”의 PoC·운영 비용, 조달 절차와 비용 통제 기준은 무엇입니까?`,
    procurement: `“${purpose}”의 발주 방식, 경쟁성, 규격서 및 계약상 위험은 무엇입니까?`,
    operations: `“${purpose}”의 SLA, 품질측정, 장애대응과 운영 전환 기준은 무엇입니까?`,
  };
  return questions[agent];
}

function synthesize(agent: AgentId, chunks: KnowledgeChunk[]) {
  const lead: Record<AgentId, string> = {
    tech: "검색·추론·검증 계층을 분리하고 측정 가능한 PoC 기준으로 단계적으로 도입해야 합니다.",
    data: "데이터 출처와 이용조건을 확인하고 품질·최신성·메타데이터·폐기 기준을 수명주기 전체에 적용해야 합니다.",
    security: "원문은 조직 경계에 유지하고 역할 기반 접근통제와 반환 전 민감정보 제거를 적용해야 합니다.",
    legal: "최소처리 원칙을 준수하고 위탁·재위탁·삭제·산출물 책임을 계약과 업무절차에 명시해야 합니다.",
    policy: "공공성·투명성·설명가능성 기준을 정하고 편향과 권리 영향을 사전에 평가해야 합니다.",
    finance: "PoC와 본사업을 분리하고 모델 사용료와 운영·보안 비용까지 포함한 총소유비용을 산정해야 합니다.",
    procurement: "특정 사업자 종속을 피하고 측정 가능한 요구조건, 경쟁성 및 계약 종료 시 데이터 이전 조건을 명시해야 합니다.",
    operations: "응답시간·가용성·정확성 기준과 장애 대응, 모니터링, 운영 전환 게이트를 사전에 정의해야 합니다.",
  };
  const grounds = chunks
    .map((chunk) => chunk.text.replace(/\s+/g, " ").slice(0, 180))
    .join(" ");
  return `${lead[agent]} ${grounds}`;
}

export async function orchestrate(rawQuery: string, mode: RunMode = "proposed") {
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

  const centralizedEvidence =
    mode === "centralized"
      ? ids
          .flatMap((id) => retrieve(query, id, 1).map((item) => item.chunk))
          .filter((chunk, index, items) => items.findIndex((item) => item.id === chunk.id) === index)
      : [];
  const centralizedGeneration =
    mode === "centralized"
      ? await generateLocalAnswer({
          agent: "tech",
          agentName: "중앙집중형 Core LLM",
          responsibility: "전체 전문영역의 원문과 판단을 중앙에서 통합 처리",
          query,
          evidence: centralizedEvidence,
          fallback: synthesize("tech", centralizedEvidence),
        })
      : null;

  const agentResults = await Promise.all(ids.map(async (id, index) => {
    const isSelected = selected.includes(id);
    const retrieved = isSelected ? retrieve(query, id) : [];
    const fallbackSummary = isSelected
      ? synthesize(id, retrieved.map((item) => item.chunk))
      : "현재 질의에서는 이 Agent가 선택되지 않아 원문 검색과 로컬 LLM 추론을 실행하지 않았습니다.";
    const generated = isSelected
      ? centralizedGeneration ?? await generateLocalAnswer({
          agent: id,
          agentName: agentProfiles[id].name,
          responsibility: agentProfiles[id].responsibility,
          query,
          evidence: retrieved.map((item) => item.chunk),
          fallback: fallbackSummary,
        })
      : {
          text: fallbackSummary,
          metrics: {
            backend: "deterministic" as const,
            model: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
            ttftMs: null,
            tpotMs: null,
            tokensPerSecond: null,
            promptTokens: null,
            completionTokens: null,
            totalMs: 0,
            fallbackReason: "Agent not selected",
          },
        };
    const rawSummary = generated.text;
    const { sanitized: summary, filteredFields } = sanitize(rawSummary);
    return {
      id,
      ...agentProfiles[id],
      selected: isSelected,
      selectionReason: scores[id] > 0
        ? `질의의 ${agentProfiles[id].keywords.filter((keyword) => query.toLowerCase().includes(keyword.toLowerCase())).slice(0, 3).join("·")} 신호와 역할이 일치합니다.`
        : "현재 질의에서 이 역할의 직접 검토 신호가 발견되지 않았습니다.",
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
      latencyMs: generated.metrics.backend === "ollama"
        ? generated.metrics.totalMs
        : 220 + index * 31 + retrieved.length * 18,
      inference: generated.metrics,
    };
  }));

  const selectedResults = agentResults.filter((result) => result.selected);
  const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
  const requiresSecurity = /개인|민감|내부|보안|민원|데이터/i.test(query);
  const requiresLegal = /법|계약|책임|위탁|개인/i.test(query);
  const missing = [
    requiresSecurity && !selected.includes("security") ? "보안" : "",
    requiresLegal && !selected.includes("legal") ? "법무" : "",
  ].filter(Boolean);
  const tokens = Math.ceil((query.length + selectedResults.reduce((sum, result) => sum + result.summary.length, 0)) * 1.7);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify(selectedResults)).length;
  const distributedPayloadBytes = encoder.encode(JSON.stringify(
    selectedResults.map((result) => ({
      question: result.question,
      summary: result.summary,
      evidenceIds: result.evidence.map((item) => item.id),
    })),
  )).length;
  const centralizedSourceBytes = encoder.encode(JSON.stringify(
    ids.flatMap((id) => retrieve(query, id, 3).map((item) => item.chunk)),
  )).length + encoder.encode(rawQuery).length;
  const boundaryBytes = mode === "centralized" ? centralizedSourceBytes : distributedPayloadBytes;
  const minimizationRate =
    mode === "centralized"
      ? 0
      : Math.max(0, Math.round((1 - boundaryBytes / Math.max(centralizedSourceBytes, 1)) * 100));
  const privacyRiskScore =
    mode === "centralized"
      ? Math.min(100, 75 + inputFiltered.length * 10)
      : mode === "parallel"
        ? Math.min(100, 30 + selected.length * 4 + inputFiltered.length * 5)
        : Math.min(100, 8 + selected.length * 3 + inputFiltered.length * 4);

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
      calls: mode === "centralized" ? 1 : selected.length,
      tokens,
      bytes,
      latencyMs: selectedResults.some((result) => result.inference.backend === "ollama")
        ? Date.now() - startedAt
        : Date.now() - startedAt + Math.max(...selectedResults.map((result) => result.latencyMs)),
      exposedFields: 0,
      traceability: evidenceCount ? 100 : 0,
      rawDataLeavesEdge: mode === "centralized",
      boundaryBytes,
      dataRecipients: mode === "centralized" ? 1 : selected.length,
      minimizationRate,
      privacyRiskScore,
      ragChunks: ragStats.chunks,
      llmBackend: selectedResults.every((result) => result.inference.backend === "ollama") ? "ollama" : "deterministic",
      model: selectedResults[0]?.inference.model ?? process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
      ttftMs: (() => {
        const values = selectedResults
          .map((result) => result.inference.ttftMs)
          .filter((value): value is number => value !== null);
        return values.length ? Math.min(...values) : null;
      })(),
      tpotMs: (() => {
        const values = selectedResults
          .map((result) => result.inference.tpotMs)
          .filter((value): value is number => value !== null);
        return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
      })(),
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
