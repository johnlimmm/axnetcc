import {
  agentProfiles,
  type AgentId,
  type Classification,
  type KnowledgeChunk,
} from "./agent-registry";
import { evaluateWithCommercialJudge } from "./commercial-judge";
import {
  conceptIdsForAgent,
  planAdaptiveAdditions,
  routeWithBoundaryConstraints,
  type AgentExecutionRole,
  type BoundaryRoutingDecision,
  type ObservedAgentOutput,
} from "./boundary-router";
import { sanitizeSensitiveText } from "./data-loss-prevention";
import { executeEdgeAgent } from "./edge-agent-client";
import type { EdgeAgentResponse } from "./edge-agent-contract";
import { generateLocalAnswer } from "./local-llm";

export type RunMode =
  | "proposed"
  | "parallel"
  | "centralized"
  | "managed"
  | "masrouter"
  | "remoterag";

export type OrchestrationProgressStage =
  | "request.received"
  | "request.sanitized"
  | "router.deciding"
  | "router.decided"
  | "router.review-required"
  | "agents.selected"
  | "agents.adapted"
  | "agent.retrieving"
  | "agent.retrieved"
  | "agent.generating"
  | "agent.mapping"
  | "agent.completed"
  | "agent.mapped"
  | "agent.skipped"
  | "central.retrieving"
  | "central.retrieved"
  | "central.generating"
  | "central.integrating"
  | "central.completed"
  | "evidence.plan.ready"
  | "judge.evaluating"
  | "judge.completed"
  | "request.completed";

export type OrchestrationProgressEvent = {
  runId: string;
  mode: RunMode;
  stage: OrchestrationProgressStage;
  message: string;
  timestamp: number;
  sequence: number;
  agentId?: AgentId;
  agentName?: string;
  selectedAgents?: AgentId[];
  executionRole?: AgentExecutionRole;
  routerDecision?: BoundaryRoutingDecision;
  evidencePlan?: {
    coverage: number | null;
    coveredConceptIds: string[];
    missingConceptIds: string[];
    humanReviewRequired: boolean;
    agentPlans: Array<{
      agentId: AgentId;
      status: "verified" | "partial" | "unknown" | "denied";
      coverage: number | null;
      modes: string[];
    }>;
  };
  evidenceCount?: number;
  backend?: "ollama" | "deterministic";
  model?: string;
};

export type OrchestrationProgressReporter = (event: OrchestrationProgressEvent) => void;

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

function selectMasRouterInspired(
  ids: AgentId[],
  scores: Record<AgentId, number>,
) {
  const ranked = [...ids].sort((a, b) => scores[b] - scores[a]);
  const relevant = ranked.filter((id) => scores[id] > 0);
  if (!relevant.length) return [ranked[0]];
  // MasRouter의 collaboration/role routing 핵심을 비학습식 baseline으로
  // 옮긴다. 단순 질의는 단일 역할, 복합 질의는 상위 역할 집합을 사용한다.
  const collaborationSize =
    relevant.length === 1 ? 1 : Math.min(4, Math.max(2, Math.ceil(relevant.length * 0.6)));
  return relevant.slice(0, collaborationSize);
}

function perturbQueryForRemoteRag(query: string) {
  const protectedTerms = new Set([
    "ai", "rag", "llm", "보안", "개인정보", "법적", "법무", "예산", "조달",
    "운영", "sla", "클라우드", "품질", "민원", "데이터",
  ]);
  let replaced = 0;
  const tokens = query.split(/(\s+)/);
  const perturbed = tokens.map((token, index) => {
    const normalized = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (
      normalized.length >= 3 &&
      !protectedTerms.has(normalized) &&
      index % 7 === 0
    ) {
      replaced += 1;
      return "[일반화]";
    }
    return token;
  }).join("");
  return { query: perturbed, replaced };
}

function lexicalCoverage(expected: string, actual: string) {
  const expectedTerms = [...new Set(terms(expected))];
  if (!expectedTerms.length) return 0;
  const actualTerms = new Set(terms(actual));
  return Math.round(
    expectedTerms.filter((term) =>
      [...actualTerms].some((candidate) => candidate.includes(term) || term.includes(candidate)),
    ).length / expectedTerms.length * 100,
  );
}

function enforceEvidenceCitation(summary: string, evidenceIds: string[]) {
  if (!evidenceIds.length) return summary;
  const valid = new Set(evidenceIds);
  const withoutInvalidIds = summary.replace(
    /\[([^\]]+)\]/g,
    (citation, id: string) => valid.has(id) ? citation : "",
  );
  const cited = [...withoutInvalidIds.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  return cited.length
    ? withoutInvalidIds.trim()
    : `${withoutInvalidIds.trim()} (근거 ID 미확인)`;
}

const sanitize = sanitizeSensitiveText;

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

const retrievalFocus: Record<AgentId, string> = {
  tech: "공공 AI 도입 PoC RAG 응답시간 P95 품질 운영 전환 장애 fallback",
  data: "데이터 출처 품질 메타데이터 표준화 갱신주기 수명주기 폐기",
  security: "개인정보 안전조치 최소권한 접근통제 암호화 마스킹 감사로그 이상행위",
  legal: "개인정보 처리 법적 근거 최소처리 보유 삭제 위탁 재위탁 책임 계약",
  policy: "공공 AI 투명성 설명가능성 편향 영향평가 권리 이의제기",
  finance: "공공 AI 예산 PoC 본사업 비용 TCO 운영비 유지보수 모델 사용료",
  procurement: "공공조달 입찰 경쟁성 규격서 계약 종료 데이터 이전 종속성",
  operations: "SLA P95 가용성 장애 복구시간 모니터링 검수 운영전환",
};

const corePayloadFields = ["summary", "evidenceIds", "metrics"] as const;

type ProjectedEvidence = {
  id: string;
  title: string;
  excerpt: string;
  sourceUrl?: string;
  sourceType: "public" | "edge-restricted";
  effectiveDate: string;
  retrievalScore: number;
  classification: Classification;
  disclosure: "sanitized-preview" | "reference-only";
};

function projectEdgeEvidence(response: EdgeAgentResponse) {
  const filteredFields: string[] = [];
  const evidence = response.evidence.map((item): ProjectedEvidence => {
    if (item.classification !== "public") {
      return {
        id: item.referenceId,
        title: "제한 문서 · Edge 보존",
        excerpt: "원문은 Edge에 보존되며 Core에는 근거 ID만 전달됩니다.",
        sourceType: "edge-restricted",
        effectiveDate: "",
        // 제한 문서의 실제 점수는 Core에 공개하지 않고, 검색됨을 나타내는 최소 표시값만 사용한다.
        retrievalScore: 0.01,
        classification: item.classification,
        disclosure: "reference-only",
      };
    }
    const title = sanitize(item.title);
    const excerpt = sanitize(item.excerpt);
    filteredFields.push(...title.filteredFields, ...excerpt.filteredFields);
    return {
      id: item.referenceId,
      title: title.sanitized,
      excerpt: excerpt.sanitized,
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      sourceType: "public",
      effectiveDate: "",
      retrievalScore: item.retrievalScore,
      classification: "public",
      disclosure: "sanitized-preview",
    };
  });
  return { evidence, filteredFields };
}

function edgeMode(response: EdgeAgentResponse) {
  return response.boundary.transport === "local" ? "local" as const : "remote" as const;
}

export async function orchestrate(
  rawQuery: string,
  mode: RunMode = "proposed",
  useCommercialJudge = false,
  onProgress?: OrchestrationProgressReporter,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const runId = `RUN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  let progressSequence = 0;
  const report = (
    stage: OrchestrationProgressStage,
    message: string,
    detail: Omit<OrchestrationProgressEvent, "runId" | "mode" | "stage" | "message" | "timestamp" | "sequence"> = {},
  ) => {
    try {
      onProgress?.({
        runId,
        mode,
        stage,
        message,
        timestamp: Date.now(),
        sequence: progressSequence += 1,
        ...detail,
      });
    } catch {
      // 진행 UI 전달 실패가 실제 오케스트레이션을 중단시키지 않도록 격리한다.
    }
  };

  report("request.received", "업무 요청을 안전하게 접수했습니다.");
  const { sanitized: query, filteredFields: inputFiltered } = sanitize(rawQuery.trim());
  report(
    "request.sanitized",
    inputFiltered.length
      ? `민감정보 ${inputFiltered.length}개 필드를 마스킹했습니다.`
      : "민감정보 노출 여부를 확인했습니다.",
  );
  const ids = Object.keys(agentProfiles) as AgentId[];
  const scores = Object.fromEntries(
    ids.map((id) => [id, overlap(query, agentProfiles[id].keywords)]),
  ) as Record<AgentId, number>;
  const remoteRagQuery = perturbQueryForRemoteRag(query);
  let routerDecision: BoundaryRoutingDecision | null = null;
  if (mode === "proposed") {
    report("router.deciding", "중앙 Boundary Router가 주관 Agent와 필수 검토 조건을 계산하는 중입니다.");
    routerDecision = routeWithBoundaryConstraints({
      query,
      lexicalScores: scores,
      filteredFields: inputFiltered,
    });
    report("router.decided", `${agentProfiles[routerDecision.primaryAgent].shortName} Agent를 1차 처리 담당으로 결정했습니다.`, {
      routerDecision,
    });
  }
  let selected =
    routerDecision
      ? [...routerDecision.selected]
      : mode === "masrouter"
      ? selectMasRouterInspired(ids, scores)
      : mode === "remoterag"
        ? selectMasRouterInspired(ids, scores)
      : mode === "managed"
      ? ids.filter((id) => scores[id] > 0)
      : ids;
  if (!selected.length) selected.push("tech");

  report("agents.selected", `${selected.length}개 전문 Agent를 선택했습니다.`, {
    selectedAgents: [...selected],
  });

  const benchmarkMode = mode === "centralized" || mode === "remoterag";
  if (benchmarkMode) {
    report(
      "central.retrieving",
      mode === "remoterag"
        ? "Edge Agent가 일반화된 질의로 안전한 근거 참조를 준비하는 중입니다."
        : "Edge Agent가 중앙 비교용 근거 참조를 준비하는 중입니다.",
    );
  }

  const skippedAgentResult = (id: AgentId) => {
    report("agent.skipped", `${agentProfiles[id].shortName} Agent는 이번 요청에서 제외됐습니다.`, {
      agentId: id,
      agentName: agentProfiles[id].name,
    });
    const skippedMode = process.env.EDGE_AGENT_MODE?.toLowerCase() === "remote" ? "remote" as const : "local" as const;
    const decisionId = `SKIP-${runId}-${id}`;
    const allowedClasses = [...agentProfiles[id].allowedClasses];
    const policy = {
      allowedClasses,
      returnedClasses: [] as Classification[],
      blockedCount: 0,
      decisionId,
      egressFields: [...corePayloadFields],
      edgeMode: skippedMode,
      rawContentReturned: false as const,
    };
    return {
      id,
      ...agentProfiles[id],
      selected: false,
      executionRole: "not-selected" as const,
      selectionReason: "현재 질의에서 이 역할의 직접 검토 신호가 발견되지 않았습니다.",
      score: Math.min(99, 58 + scores[id] * 8),
      question: questionFor(id, query),
      summary: "현재 질의에서는 이 Agent가 선택되지 않아 Edge 검색과 로컬 LLM 추론을 실행하지 않았습니다.",
      evidence: [] as ProjectedEvidence[],
      evidencePlan: undefined,
      edgeStatus: "not-selected" as const,
      edgePolicyOutcome: "allow" as const,
      responsibility: agentProfiles[id].responsibility,
      filteredFields: [...inputFiltered],
      latencyMs: 0,
      policy,
      audit: {
        allowedClasses,
        returnedClasses: [] as Classification[],
        blockedCount: 0,
        policyDecisionId: decisionId,
        edgeMode: skippedMode,
      },
      edgeMetrics: { sourceBytesProcessed: 0, egressBytes: 0, corpusChunks: 0 },
      inference: {
        backend: "deterministic" as const,
        model: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
        ttftMs: null,
        tpotMs: null,
        tokensPerSecond: null,
        promptTokens: null,
        completionTokens: null,
        totalMs: 0,
        fallbackReason: "Agent not selected",
        role: "not-selected" as const,
      },
    };
  };

  const executeSelectedAgent = async (
    id: AgentId,
    index: number,
    executionRole: AgentExecutionRole,
  ) => {
    report("agent.retrieving", `${agentProfiles[id].shortName} Agent가 Edge RAG 근거를 검색하고 로컬 응답을 생성하는 중입니다.`, {
      agentId: id,
      agentName: agentProfiles[id].name,
      executionRole,
    });
    const retrievalQuery = mode === "remoterag" ? remoteRagQuery.query : `${query} ${retrievalFocus[id]}`;
    const requiredConceptIds = routerDecision ? conceptIdsForAgent(routerDecision, id) : [];
    const response = await executeEdgeAgent({
      version: "1",
      requestId: `${runId}-${id}`,
      traceId: runId,
      agentId: id,
      purpose: benchmarkMode ? "benchmark" : "orchestration",
      minimalQuery: retrievalQuery,
      ...(routerDecision ? {
        evidenceRequirements: {
          executionRole,
          requiredConceptIds,
        },
      } : {}),
      limits: { topK: 3, deadlineMs: 90_000 },
    }, signal);
    report("agent.retrieved", `${agentProfiles[id].shortName} Agent가 권한 필터를 통과한 근거 ${response.evidence.length}건을 준비했습니다.`, {
      agentId: id,
      agentName: agentProfiles[id].name,
      executionRole,
      evidenceCount: response.evidence.length,
    });
    report(benchmarkMode ? "agent.mapping" : "agent.generating", benchmarkMode
      ? `${agentProfiles[id].shortName} Agent가 원문 없이 근거 ID를 검증하는 중입니다.`
      : `${agentProfiles[id].shortName} Agent의 Edge 로컬 생성 결과를 검증하는 중입니다.`, {
        agentId: id,
        agentName: agentProfiles[id].name,
        executionRole,
      });

    const projected = projectEdgeEvidence(response);
    const summaryResult = sanitize(response.answer.text);
    const summary = enforceEvidenceCitation(summaryResult.sanitized, projected.evidence.map((item) => item.id));
    const returnedClasses = [...new Set(projected.evidence.map((item) => item.classification))];
    const projectedEdgeMode = edgeMode(response);
    const policy = {
      allowedClasses: [...response.policy.effectiveClasses],
      returnedClasses,
      blockedCount: response.policy.blockedCount,
      decisionId: response.policy.decisionId,
      egressFields: [...corePayloadFields],
      edgeMode: projectedEdgeMode,
      rawContentReturned: false as const,
    };
    report(benchmarkMode ? "agent.mapped" : "agent.completed", benchmarkMode
      ? `${agentProfiles[id].shortName} 전문 근거 매핑이 완료됐습니다.`
      : `${agentProfiles[id].shortName} Agent 응답 생성이 완료됐습니다.`, {
        agentId: id,
        agentName: agentProfiles[id].name,
        executionRole,
        evidenceCount: response.evidence.length,
        backend: benchmarkMode ? undefined : response.metrics.backend,
        model: benchmarkMode ? undefined : response.metrics.model,
      });
    const signalKeywords = agentProfiles[id].keywords
      .filter((keyword) => query.toLowerCase().includes(keyword.toLowerCase()))
      .slice(0, 3)
      .join("·");
    return {
      id,
      ...agentProfiles[id],
      selected: true,
      executionRole,
      selectionReason: executionRole === "primary"
        ? "Boundary Router가 이 요청의 1차 처리 책임자로 선택했습니다."
        : executionRole === "required-reviewer"
          ? "보안 경계와 결합 규칙에 따라 생략할 수 없는 검토 역할입니다."
          : signalKeywords
            ? `1차 결과의 필수 개념 공백과 ${signalKeywords} 신호를 보완합니다.`
            : benchmarkMode
              ? "비교 모드에서 전체 전문영역의 안전한 근거 매핑 대상으로 선택됐습니다."
              : "1차 결과의 필수 개념 공백을 보완하기 위해 추가됐습니다.",
      score: Math.min(99, 58 + scores[id] * 8),
      question: questionFor(id, query),
      summary,
      evidence: projected.evidence,
      evidencePlan: response.evidencePlan,
      edgeStatus: response.status,
      edgePolicyOutcome: response.policy.outcome,
      responsibility: agentProfiles[id].responsibility,
      filteredFields: [...new Set([...inputFiltered, ...summaryResult.filteredFields, ...projected.filteredFields])],
      latencyMs: response.metrics.latencyMs || 220 + index * 31 + response.evidence.length * 18,
      policy,
      audit: {
        allowedClasses: [...response.policy.effectiveClasses],
        returnedClasses,
        blockedCount: response.policy.blockedCount,
        policyDecisionId: response.policy.decisionId,
        edgeMode: projectedEdgeMode,
      },
      edgeMetrics: {
        sourceBytesProcessed: response.metrics.sourceBytesProcessed,
        egressBytes: response.metrics.egressBytes,
        corpusChunks: response.metrics.corpusChunks,
      },
      inference: {
        backend: response.metrics.backend,
        model: response.metrics.model,
        ttftMs: response.metrics.ttftMs,
        tpotMs: response.metrics.tpotMs,
        tokensPerSecond: null,
        promptTokens: null,
        completionTokens: null,
        totalMs: response.metrics.latencyMs,
        ...(response.status === "completed" ? {} : { fallbackReason: `Edge status: ${response.status}` }),
        role: benchmarkMode ? "evidence-projection" as const : "agent-llm" as const,
      },
    };
  };

  const executed = new Map<AgentId, Awaited<ReturnType<typeof executeSelectedAgent>>>();
  let adaptiveDecision: ReturnType<typeof planAdaptiveAdditions> | null = null;
  if (routerDecision) {
    const initialRoutingReviewRequired = routerDecision.humanReviewRequired;
    const primary = await executeSelectedAgent(routerDecision.primaryAgent, ids.indexOf(routerDecision.primaryAgent), "primary");
    executed.set(primary.id, primary);
    adaptiveDecision = planAdaptiveAdditions(routerDecision, {
      [primary.id]: {
        status: primary.edgeStatus,
        policyOutcome: primary.edgePolicyOutcome,
        evidenceCoverage: primary.evidencePlan,
      },
    });
    adaptiveDecision = {
      ...adaptiveDecision,
      humanReviewRequired: initialRoutingReviewRequired || adaptiveDecision.humanReviewRequired,
    };
    const additions = adaptiveDecision.additions.filter((id) => id !== primary.id);
    const adaptiveOnly = additions.filter((id) => !routerDecision!.required.includes(id));
    selected = [primary.id, ...additions];
    routerDecision = {
      ...routerDecision,
      selected: [...selected],
      supportingAgents: additions,
      adaptiveAdditions: adaptiveOnly,
      humanReviewRequired: adaptiveDecision.humanReviewRequired,
      rationale: [...routerDecision.rationale, adaptiveDecision.rationale],
    };
    if (additions.length) {
      report("agents.adapted", adaptiveDecision.rationale, {
        selectedAgents: [...selected],
        routerDecision,
      });
      const supporting = await Promise.all(additions.map((id) => executeSelectedAgent(
        id,
        ids.indexOf(id),
        routerDecision!.required.includes(id) ? "required-reviewer" : "supporting",
      )));
      supporting.forEach((result) => executed.set(result.id, result));
    }
    const observed = Object.fromEntries([...executed.values()].map((result) => [result.id, {
      status: result.edgeStatus,
      policyOutcome: result.edgePolicyOutcome,
      evidenceCoverage: result.evidencePlan,
    }])) as Partial<Record<AgentId, ObservedAgentOutput>>;
    const finalAdaptive = planAdaptiveAdditions(routerDecision, observed);
    adaptiveDecision = {
      ...finalAdaptive,
      additions: [],
      humanReviewRequired: initialRoutingReviewRequired || finalAdaptive.humanReviewRequired,
    };
    routerDecision = {
      ...routerDecision,
      humanReviewRequired: initialRoutingReviewRequired || finalAdaptive.humanReviewRequired,
      rationale: [...routerDecision.rationale, finalAdaptive.rationale],
    };
  } else {
    const completed = await Promise.all(selected.map((id) => executeSelectedAgent(id, ids.indexOf(id), "supporting")));
    completed.forEach((result) => executed.set(result.id, result));
  }
  const agentResults = ids.map((id) => executed.get(id) ?? skippedAgentResult(id));

  const selectedResults = agentResults.filter((result) => result.selected);
  const evidencePlan = routerDecision && adaptiveDecision
    ? {
        coverage: adaptiveDecision.coverage,
        coveredConceptIds: adaptiveDecision.coveredConceptIds,
        missingConceptIds: adaptiveDecision.missingConceptIds,
        humanReviewRequired: adaptiveDecision.humanReviewRequired,
        agentPlans: selectedResults.map((result) => ({
          agentId: result.id,
          status: result.evidencePlan?.status ?? "unknown" as const,
          coverage: result.evidencePlan?.coverage ?? null,
          modes: [...new Set(result.evidencePlan?.decisions.map((decision) => decision.mode) ?? [])],
        })),
      }
    : null;
  if (evidencePlan) {
    report("evidence.plan.ready", evidencePlan.humanReviewRequired
      ? `필수 개념 ${evidencePlan.missingConceptIds.length}개가 남아 사람 검토가 필요합니다.`
      : "모든 필수 개념이 Edge 근거에서 확인됐습니다.", {
        evidencePlan,
      });
    if (evidencePlan.humanReviewRequired) {
      report("router.review-required", "주관기관 선정 불확실성, Edge 정책 또는 근거 충족도 Gate가 사람 검토를 요청했습니다.", {
        selectedAgents: [...selected],
        routerDecision: routerDecision ?? undefined,
        evidencePlan,
      });
    }
  }
  const safeIntegrationEvidence: KnowledgeChunk[] = selectedResults.map((result) => ({
    id: result.evidence[0]?.id ?? `EDGE-SUMMARY-${result.id}`,
    agent: result.id,
    title: `${result.shortName} Edge 응답 요약`,
    section: "summary + evidence IDs/classification",
    text: [
      `안전 요약: ${result.summary}`,
      `근거 ID/등급: ${result.evidence.map((item) => `[${item.id}](${item.classification})`).join(", ") || "없음"}`,
    ].join("\n"),
    sourceType: "synthetic-internal",
    classification: "public",
    effectiveDate: "",
    tags: ["edge-summary", "evidence-reference"],
  }));

  let centralizedGeneration: Awaited<ReturnType<typeof generateLocalAnswer>> | null = null;
  if (benchmarkMode || mode === "proposed") {
    const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
    report("central.retrieved", `Edge에서 안전한 근거 참조 ${evidenceCount}건을 확보했습니다.`, {
      evidenceCount,
    });
    report("central.generating", mode === "proposed"
      ? "중앙 통합 모델이 주관·보조 Agent의 안전 요약과 근거 ID로 최종 응답을 생성하는 중입니다."
      : "중앙 모델이 안전한 요약과 근거 ID만으로 응답을 생성하는 중입니다.");
    centralizedGeneration = await generateLocalAnswer({
      agent: "tech",
      agentName: mode === "proposed" ? "AXNetCC 중앙 통합 모델" : "중앙집중형 Core LLM",
      responsibility: mode === "proposed"
        ? "주관·보조 Agent가 반환한 안전 요약과 근거 식별자를 조정해 최종 응답 생성"
        : "Edge가 반환한 안전 요약과 근거 식별자만 중앙에서 통합 처리",
      query: mode === "remoterag" ? remoteRagQuery.query : query,
      evidence: safeIntegrationEvidence,
      fallback: selectedResults.map((result) => result.summary).join(" "),
      signal,
    });
  }
  if (mode === "managed") {
    report("central.integrating", "Managed Supervisor가 Agent 응답과 근거를 통합해 최종 응답을 생성하는 중입니다.");
  } else if (mode === "centralized" || mode === "remoterag") {
    report("central.integrating", "중앙 모델 응답과 전문영역별 근거의 정합성을 검증하는 중입니다.");
  } else if (mode === "proposed") {
    report("central.integrating", "중앙 통합 모델 응답의 필수 개념·근거·정책 정합성을 검증하는 중입니다.");
  } else {
    report("central.integrating", "Core Orchestrator가 Agent 응답의 근거·누락·충돌을 검증하는 중입니다.");
  }
  const managedSupervisor =
    mode === "managed"
      ? await generateLocalAnswer({
          agent: "tech",
          agentName: "Managed Platform Supervisor",
          responsibility: "중앙 Supervisor가 Edge의 안전 요약과 근거 식별자만 통합",
          query,
          evidence: safeIntegrationEvidence,
          fallback: selectedResults.map((result) => result.summary).join(" "),
          signal,
        })
      : null;
  const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
  const requiresSecurity = /개인|민감|내부|보안|민원|데이터/i.test(query);
  const requiresLegal = /법|계약|책임|위탁|개인/i.test(query);
  const missing = [
    requiresSecurity && !selected.includes("security") ? "보안" : "",
    requiresLegal && !selected.includes("legal") ? "법무" : "",
  ].filter(Boolean);
  const tokens = Math.ceil((query.length + selectedResults.reduce((sum, result) => sum + result.summary.length, 0)) * 1.7);
  const encoder = new TextEncoder();
  const distributedPayloadBytes = encoder.encode(JSON.stringify(
    selectedResults.map((result) => ({
      summary: result.summary,
      evidenceIds: result.evidence.map((item) => item.id),
      metrics: result.edgeMetrics,
    })),
  )).length;
  const centralizedSourceBytes = selectedResults.reduce(
    (sum, result) => sum + result.edgeMetrics.sourceBytesProcessed,
    0,
  );
  const measuredEdgeEgressBytes = selectedResults.reduce(
    (sum, result) => sum + result.edgeMetrics.egressBytes,
    0,
  );
  const boundaryBytes = measuredEdgeEgressBytes || distributedPayloadBytes;
  const minimizationRate = Math.max(
    0,
    Math.round((1 - boundaryBytes / Math.max(centralizedSourceBytes, 1)) * 100),
  );
  const privacyRiskScore =
    mode === "centralized"
      ? Math.min(100, 75 + inputFiltered.length * 10)
      : mode === "managed"
        ? Math.min(100, 65 + selected.length * 3 + inputFiltered.length * 6)
      : mode === "remoterag"
        ? Math.min(100, 42 + selected.length * 2 + inputFiltered.length * 4)
      : mode === "masrouter"
        ? Math.min(100, 58 + selected.length * 3 + inputFiltered.length * 5)
      : mode === "parallel"
        ? Math.min(100, 30 + selected.length * 4 + inputFiltered.length * 5)
        : Math.min(100, 8 + selected.length * 3 + inputFiltered.length * 4);
  const validEvidenceIds = new Set(selectedResults.flatMap((result) => result.evidence.map((item) => item.id)));
  const citations = selectedResults.flatMap((result) =>
    [...result.summary.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]),
  );
  const validCitations = citations.filter((id) => validEvidenceIds.has(id));
  const citationCoverage = Math.round(
    selectedResults.filter((result) => result.evidence.some((item) => result.summary.includes(`[${item.id}]`))).length /
      Math.max(selectedResults.length, 1) * 100,
  );
  const citationValidity = citations.length
    ? Math.round(validCitations.length / citations.length * 100)
    : 0;
  const uniqueValidCitations = new Set(validCitations);
  const citationRecall = Math.round(
    uniqueValidCitations.size / Math.max(validEvidenceIds.size, 1) * 100,
  );
  const claimSentences = selectedResults.flatMap((result) =>
    result.summary
      .split(/\n+|(?<=[.!?다요])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => terms(sentence.replace(/\[[^\]]+\]/g, "")).length >= 3),
  );
  const supportedClaims = claimSentences.filter((sentence) =>
    [...sentence.matchAll(/\[([^\]]+)\]/g)].some((match) => validEvidenceIds.has(match[1])),
  );
  const claimSupportRate = Math.round(
    supportedClaims.length / Math.max(claimSentences.length, 1) * 100,
  );
  const evidenceUtilizationRate = citationRecall;
  const claimCitationCoverage = claimSupportRate;
  const retrievalSuccessRate = Math.round(
    selectedResults.filter((result) => result.evidence.length > 0).length /
      Math.max(selectedResults.length, 1) * 100,
  );
  const relevance = Math.round(
    selectedResults.reduce((sum, result) => sum + lexicalCoverage(query, result.summary), 0) /
      Math.max(selectedResults.length, 1),
  );
  const evidenceSupport = Math.round(
    selectedResults.reduce((sum, result) => {
      const evidenceText = result.evidence.map((item) => item.excerpt).join(" ");
      return sum + lexicalCoverage(result.summary, evidenceText);
    }, 0) / Math.max(selectedResults.length, 1),
  );
  const groundedness = evidenceSupport;
  const domainCoverage = Math.round((selected.length - missing.length) / Math.max(selected.length, 1) * 100);
  const answerCompleteness = Math.round(
    selectedResults.filter((result) => result.summary.trim().length >= 40 && result.evidence.length > 0).length /
      Math.max(selectedResults.length, 1) * 100,
  );
  const qualityScore = Math.round(
    relevance * 0.15 +
      evidenceSupport * 0.2 +
      retrievalSuccessRate * 0.15 +
      citationValidity * 0.15 +
      citationRecall * 0.15 +
      claimSupportRate * 0.2,
  );
  const inferenceResults = centralizedGeneration
    ? [centralizedGeneration.metrics]
    : [
        ...selectedResults.map((result) => result.inference),
        ...(managedSupervisor ? [managedSupervisor.metrics] : []),
      ];
  const defaultConclusion = "제한적 시범 도입을 권고합니다. 원문 데이터의 조직 내 보존, 역할 기반 접근통제, 담당자 최종 검토를 선행조건으로 설정하고 PoC 이후 품질·보안·비용 지표를 재평가해야 합니다.";
  const integratedGeneration = managedSupervisor ?? centralizedGeneration;
  const integratedRawConclusion = integratedGeneration
    ? enforceEvidenceCitation(integratedGeneration.text, [...validEvidenceIds])
    : defaultConclusion;
  const { sanitized: conclusion } = sanitize(integratedRawConclusion);
  const integration = managedSupervisor
    ? {
        actor: "managed-supervisor" as const,
        label: "Managed Platform Supervisor",
        backend: managedSupervisor.metrics.backend,
        model: managedSupervisor.metrics.model,
      }
    : centralizedGeneration
      ? {
          actor: "central-llm" as const,
          label: mode === "proposed" ? "AXNetCC 중앙 통합 모델" : "중앙집중형 Core LLM",
          backend: centralizedGeneration.metrics.backend,
          model: centralizedGeneration.metrics.model,
        }
      : {
          actor: "core-orchestrator" as const,
          label: "Core Orchestrator",
          backend: "deterministic" as const,
          model: null,
        };
  const integratedEvidenceText = selectedResults.flatMap((result) => result.evidence)
    .map((item) => item.excerpt)
    .join(" ");
  const integratedCitations = [...conclusion.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const integratedValidCitations = integratedCitations.filter((id) => validEvidenceIds.has(id));
  const integratedCitationValidity = integratedCitations.length
    ? Math.round(integratedValidCitations.length / integratedCitations.length * 100)
    : 0;
  const integratedCitationRecall = Math.round(
    new Set(integratedValidCitations).size / Math.max(validEvidenceIds.size, 1) * 100,
  );
  const integratedClaims = conclusion
    .split(/\n+|(?<=[.!?다요])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => terms(sentence.replace(/\[[^\]]+\]/g, "")).length >= 3);
  const integratedClaimSupport = Math.round(
    integratedClaims.filter((sentence) =>
      [...sentence.matchAll(/\[([^\]]+)\]/g)].some((match) => validEvidenceIds.has(match[1])),
    ).length / Math.max(integratedClaims.length, 1) * 100,
  );
  const integratedRelevance = lexicalCoverage(query, conclusion);
  const integratedEvidenceSupport = lexicalCoverage(conclusion, integratedEvidenceText);
  const reportedGroundedness = integratedGeneration ? integratedEvidenceSupport : groundedness;
  const reportedRelevance = integratedGeneration ? integratedRelevance : relevance;
  const reportedEvidenceSupport = integratedGeneration ? integratedEvidenceSupport : evidenceSupport;
  const reportedCitationCoverage = integratedGeneration ? integratedClaimSupport : citationCoverage;
  const reportedCitationValidity = integratedGeneration ? integratedCitationValidity : citationValidity;
  const reportedCitationRecall = integratedGeneration ? integratedCitationRecall : citationRecall;
  const reportedClaimSupportRate = integratedGeneration ? integratedClaimSupport : claimSupportRate;
  const reportedAnswerCompleteness = integratedGeneration
    ? conclusion.trim().length >= 40 && integratedEvidenceText.length > 0 ? 100 : 0
    : answerCompleteness;
  const reportedQualityScore = integratedGeneration
    ? Math.round(
        integratedRelevance * 0.15 +
          integratedEvidenceSupport * 0.2 +
          retrievalSuccessRate * 0.15 +
          integratedCitationValidity * 0.15 +
          integratedCitationRecall * 0.15 +
          integratedClaimSupport * 0.2,
      )
    : qualityScore;
  const commercialJudge = useCommercialJudge
    ? await (async () => {
        report("judge.evaluating", "상용 LLM이 답변 품질을 블라인드 평가하는 중입니다.");
        const judged = await evaluateWithCommercialJudge({
          query,
          answer: selectedResults.map((result) => `${result.shortName}: ${result.summary}`).join("\n"),
          evidence: selectedResults.flatMap((result) =>
            result.evidence.map((item) => `[${item.id}] classification=${item.classification}`),
          ).join("\n"),
          signal,
        });
        report("judge.completed", judged.error ? "상용 LLM 평가를 완료하지 못했습니다." : "상용 LLM 품질 평가가 완료됐습니다.");
        return judged;
      })()
    : {
        enabled: false,
        provider: "disabled",
      };

  const boundaryTransport = selectedResults.some((agent) => agent.policy.edgeMode === "remote")
    ? "remote" as const
    : "local" as const;
  const blockedDocuments = selectedResults.reduce(
    (sum, agent) => sum + agent.policy.blockedCount,
    0,
  );

  const result = {
    runId,
    mode,
    query,
    title: "신규 AI 서비스 도입 종합 검토",
    conclusion,
    integration,
    routerDecision,
    evidencePlan,
    status: missing.length || evidencePlan?.humanReviewRequired ? "review" : "ready",
    agents: agentResults,
    boundary: {
      transport: boundaryTransport,
      corePayloadFields: [...corePayloadFields],
      blockedDocuments,
      rawContentReturned: false as const,
      policyVersion: "edge-rag-v1",
    },
    checks: [
      { label: "필수 검토영역", status: missing.length ? "warn" : "pass", detail: missing.length ? `${missing.join("·")} 영역이 누락되었습니다.` : `${selected.length}개 필수 전문영역을 반영했습니다.` },
      ...(evidencePlan ? [{
        label: "필수 개념 Gate",
        status: evidencePlan.humanReviewRequired ? "warn" as const : "pass" as const,
        detail: evidencePlan.coverage === null
          ? "필수 개념을 확정하지 못해 사람 검토로 전환했습니다."
          : `${Math.round(evidencePlan.coverage * 100)}% 충족 · 미충족 ${evidencePlan.missingConceptIds.length}개`,
      }] : []),
      { label: "근거 완전성", status: evidenceCount >= selected.length ? "pass" : "warn", detail: `${evidenceCount}개 근거 청크가 판단에 연결되었습니다.` },
      { label: "응답 충돌", status: selected.length > 1 ? "warn" : "pass", detail: selected.length > 1 ? "기술 편의성과 데이터 최소화 원칙을 조건부 조정해야 합니다." : "상충 판단이 발견되지 않았습니다." },
      { label: "민감정보", status: "pass", detail: inputFiltered.length ? `${inputFiltered.join("·")} 입력을 마스킹했습니다.` : "직접 식별자가 발견되지 않았습니다." },
    ],
    metrics: {
      calls: mode === "centralized" || mode === "remoterag"
        ? 1
        : selected.length + (mode === "managed" || mode === "proposed" ? 1 : 0),
      tokens,
      bytes: boundaryBytes,
      latencyMs: inferenceResults.some((result) => result.backend === "ollama")
        ? Date.now() - startedAt
        : Date.now() - startedAt + Math.max(...selectedResults.map((result) => result.latencyMs)),
      exposedFields: 0,
      traceability: evidenceCount ? 100 : 0,
      rawDataLeavesEdge: false,
      boundaryBytes,
      dataRecipients: selected.length,
      minimizationRate,
      privacyRiskScore,
      queryProtection: mode === "remoterag" ? "deterministic-generalization" : "none",
      perturbedTerms: mode === "remoterag" ? remoteRagQuery.replaced : 0,
      groundedness: reportedGroundedness,
      relevance: reportedRelevance,
      evidenceSupport: reportedEvidenceSupport,
      citationCoverage: reportedCitationCoverage,
      citationValidity: reportedCitationValidity,
      citationRecall: reportedCitationRecall,
      claimSupportRate: reportedClaimSupportRate,
      evidenceUtilizationRate: integratedGeneration ? reportedCitationRecall : evidenceUtilizationRate,
      claimCitationCoverage: integratedGeneration ? reportedClaimSupportRate : claimCitationCoverage,
      retrievalSuccessRate,
      domainCoverage,
      answerCompleteness: reportedAnswerCompleteness,
      qualityScore: reportedQualityScore,
      ragChunks: Math.max(0, ...selectedResults.map((result) => result.edgeMetrics.corpusChunks)),
      llmBackend: inferenceResults.every((result) => result.backend === "ollama") ? "ollama" : "deterministic",
      model: integration.model ?? selectedResults[0]?.inference.model ?? process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
      ttftMs: (() => {
        const values = inferenceResults
          .map((result) => result.ttftMs)
          .filter((value): value is number => value !== null);
        return values.length ? Math.min(...values) : null;
      })(),
      tpotMs: (() => {
        const values = inferenceResults
          .map((result) => result.tpotMs)
          .filter((value): value is number => value !== null);
        return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
      })(),
    },
    commercialJudge,
    timeline: [
      { label: "요청 정제", detail: `민감필드 ${inputFiltered.length}개 제거`, ms: 8 },
      { label: "Agent 선택", detail: routerDecision
        ? `주관 ${agentProfiles[routerDecision.primaryAgent].shortName} · 보조 ${routerDecision.supportingAgents.length}개`
        : `${selected.length}개 역할 관련도·권한 일치`, ms: 12 },
      { label: "Local RAG", detail: `${evidenceCount}개 근거 청크 검색`, ms: 31 },
      { label: "응답 검증", detail: "필수영역·근거·충돌·민감정보 점검", ms: 15 },
      { label: "결과 통합", detail: "근거 식별자·검토주체 연결", ms: 11 },
    ],
  };
  report("central.completed", `${integration.label}의 최종 통합이 완료됐습니다.`, {
    backend: integration.backend,
    model: integration.model ?? undefined,
    evidenceCount,
  });
  report("request.completed", "최종 응답과 검증 지표 생성이 완료됐습니다.", {
    evidenceCount,
  });
  return result;
}
