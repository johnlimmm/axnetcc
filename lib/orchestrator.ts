import { groundedAnswersEnabled, groundedUnavailable, groundedTopK } from "./grounded-answer";
import { demoSynthesisEnabled, publicDemoSynthesis, filterDemoSynthesisCitations } from "./demo-synthesis";
import { recordInferenceStage, markInferenceAccountingIncomplete } from "./distributed-metrics";
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
import type {
  CoreEdgeAgentResponse,
  CoreFallbackReasonCode,
} from "./edge-core-contract";
import {
  executionMetricsForRequest,
  scheduleAgentTask,
  scheduleCommercialJudgeTask,
  scheduleLocalLlmTask,
} from "./execution-scheduler";
import { generateLocalAnswer } from "./local-llm";
import { telemetry } from "./telemetry";
import {
  METRIC_PROVENANCE_VERSION,
  aggregateInferenceTokenCounts,
  calculateCitationTraceability,
  calculateElapsedMetric,
  derivedMetric,
  detectExplicitClaimConflicts,
} from "./metric-provenance";
import {
  calculatePrivacyRiskV2,
  type EgressEnvelope,
} from "./privacy-risk";
import {
  assertCoordinatorDeploymentSupported,
  requestCoordinator,
} from "./request-coordinator";
import {
  buildAgentEvidenceReport,
  buildIntegratedEvidenceReport,
} from "./report-contract";

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
      transfers: Array<{
        referenceId: string;
        plannedMode: string;
        appliedMode: string;
        egressBytes: number;
      }>;
    }>;
  };
  evidenceCount?: number;
  backend?: "ollama" | "deterministic";
  model?: string;
  execution?: {
    executionStatus: "queued" | "running" | "integrating" | "completed" | "partial_failed" | "failed" | "cancelled";
    totalCount: number;
    terminalCount: number;
    remainingCount: number;
    version: number;
  };
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
  if (groundedAnswersEnabled()) return filterDemoSynthesisCitations(summary, new Set(evidenceIds));
  if (!evidenceIds.length) return summary;
  const valid = new Set(evidenceIds);
  const withoutInvalidIds = summary.replace(
    /\[([^\]]+)\]/g,
    (citation, id: string) => valid.has(id) ? citation : "",
  );
  const cited = [...withoutInvalidIds.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  return cited.length
    ? withoutInvalidIds.trim()
    : `${withoutInvalidIds.trim()} (검증된 근거: [${evidenceIds[0]}])`;
}

const sanitize = sanitizeSensitiveText;

function questionFor(agent: AgentId) {
  const questions: Record<AgentId, string> = {
    tech: "요청을 위한 최소 기술 구성, 품질 기준과 운영 전환 조건은 무엇입니까?",
    data: "필요 데이터의 출처, 품질, 수명주기와 이용 조건은 무엇입니까?",
    security: "허용 가능한 데이터 범위와 필수 보안 통제는 무엇입니까?",
    legal: "적용되는 법적 의무, 계약 조건과 최종 판단 책임은 무엇입니까?",
    policy: "공공성, 투명성, 편향 및 영향평가 기준은 무엇입니까?",
    finance: "PoC·운영 비용, 조달 절차와 비용 통제 기준은 무엇입니까?",
    procurement: "발주 방식, 경쟁성, 규격서 및 계약상 위험은 무엇입니까?",
    operations: "SLA, 품질측정, 장애대응과 운영 전환 기준은 무엇입니까?",
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

const corePayloadFields = ["summary", "evidenceRefs", "metrics", "policy", "audit"] as const;

function settleCoordinatorTaskAfterError(
  requestId: string,
  taskId: string,
  signal?: AbortSignal,
) {
  const request = requestCoordinator.getRequest(requestId);
  if (signal?.aborted) {
    if (request && !["completed", "partial_failed", "failed", "cancelled"].includes(request.status)) {
      requestCoordinator.cancelRequest(requestId);
    }
    return;
  }
  const task = requestCoordinator.getTask(taskId);
  if (task?.status === "running") requestCoordinator.transitionTask(taskId, "failed");
  else if (task?.status === "queued") requestCoordinator.transitionTask(taskId, "cancelled");
}

function deterministicIntegrationFailure(
  fallback: string,
  reason: string,
): Awaited<ReturnType<typeof generateLocalAnswer>> {
  return {
    text: fallback,
    metrics: {
      backend: "deterministic",
      answerSource: "deterministic-fallback",
      model: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
      transport: "none",
      ttftMs: null,
      tpotMs: null,
      tokensPerSecond: null,
      promptTokens: null,
      completionTokens: null,
      totalMs: 0,
      fallbackReason: reason,
    },
  };
}

type ProjectedEvidence = {
  id: string;
  title: string;
  excerpt: string;
  sourceUrl?: string;
  sourceType: "public" | "edge-restricted";
  effectiveDate: string;
  section?: string;
  sourceSha256?: string;
  licenseReview?: string;
  retrievalScore: number;
  classification: Classification;
  disclosure: "sanitized-preview" | "reference-only";
};

function projectEdgeEvidence(response: CoreEdgeAgentResponse) {
  const evidence = response.evidenceRefs.map((item): ProjectedEvidence => {
    if (item.disclosure === "sanitized-preview") {
      return {
        id: item.referenceId,
        title: item.title,
        excerpt: item.excerpt,
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
        sourceType: "public",
        effectiveDate: item.publishedAt ?? "",
        section: item.section,
        sourceSha256: item.sourceSha256,
        licenseReview: item.licenseReview,
        retrievalScore: item.retrievalScore,
        classification: "public",
        disclosure: "sanitized-preview",
      };
    }
    return {
      id: item.referenceId,
      title: "제한 문서 · Edge 보존",
      excerpt: "문서 원문과 URL은 Edge에 보존되며 Core에는 근거 ID와 등급만 전달됩니다.",
      sourceType: "edge-restricted",
      effectiveDate: "",
      retrievalScore: 0.01,
      classification: item.classification,
      disclosure: "reference-only",
    };
  });
  return { evidence, filteredFields: [] as string[] };
}

function edgeMode(response: CoreEdgeAgentResponse) {
  return response.boundary.transport === "local" ? "local" as const : "remote" as const;
}

function safeFallbackReason(code: CoreFallbackReasonCode | undefined, status: CoreEdgeAgentResponse["status"]) {
  const labels: Record<CoreFallbackReasonCode, string> = {
    "not-configured": "Local LLM endpoint is not configured",
    "empty-response": "Local LLM returned an empty response",
    timeout: "Local LLM request timed out",
    "http-error": "Local LLM returned an HTTP error",
    "connection-error": "Local LLM connection failed",
    "edge-status": `Edge status: ${status}`,
    unknown: "Local LLM used a deterministic fallback",
  };
  return code ? labels[code] : `Edge status: ${status}`;
}

export async function orchestrate(
  rawQuery: string,
  mode: RunMode = "proposed",
  useCommercialJudge = false,
  onProgress?: OrchestrationProgressReporter,
  signal?: AbortSignal,
  requestedRunId?: string,
) {
  const runId = requestedRunId && /^RUN-[A-Z0-9-]{8,64}$/.test(requestedRunId)
    ? requestedRunId : `RUN-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  telemetry.begin(runId, mode);
  try {
    const result = await executeOrchestration(rawQuery, mode, useCommercialJudge, (event) => {
      telemetry.progress(runId, event.stage);
      onProgress?.(event);
    }, signal, runId);
    const status = result.executionStatus;
    telemetry.finish(runId, status === "partial_failed" || status === "failed" || status === "cancelled" ? status : "completed", result);
    return result;
  } catch (error) {
    telemetry.finish(runId, signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}

async function executeOrchestration(
  rawQuery: string,
  mode: RunMode = "proposed",
  useCommercialJudge = false,
  onProgress?: OrchestrationProgressReporter,
  signal?: AbortSignal,
  requestedRunId?: string,
) {
  assertCoordinatorDeploymentSupported();
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const runId = requestedRunId && /^RUN-[A-Z0-9-]{8,64}$/.test(requestedRunId)
    ? requestedRunId
    : `RUN-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  let progressSequence = 0;
  const report = (
    stage: OrchestrationProgressStage,
    message: string,
    detail: Omit<OrchestrationProgressEvent, "runId" | "mode" | "stage" | "message" | "timestamp" | "sequence"> = {},
  ) => {
    try {
      const execution = requestCoordinator.getRequest(runId);
      onProgress?.({
        runId,
        mode,
        stage,
        message,
        timestamp: Date.now(),
        sequence: progressSequence += 1,
        ...(execution ? {
          execution: {
            executionStatus: execution.status,
            totalCount: execution.progress.total,
            terminalCount: execution.progress.total - execution.progress.remaining,
            remainingCount: execution.progress.remaining,
            version: execution.version,
          },
        } : {}),
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
  if (mode === "proposed" || mode === "managed") {
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

  const optionalAgents = routerDecision
    ? routerDecision.candidateAgents.filter((id) => !selected.includes(id))
    : [];
  const executionPlan = requestCoordinator.planRequest({
    requestId: runId,
    mode,
    selectedAgents: [...selected],
    optionalAgents,
    useCommercialJudge,
    createdAt: startedAt,
  });

  // Managed keeps Supervisor integration, but now uses the same primary and
  // supporting Agent routing contract as the proposed architecture.
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
      question: questionFor(id),
      summary: "현재 질의에서는 이 Agent가 선택되지 않아 Edge 검색과 로컬 LLM 추론을 실행하지 않았습니다.",
      report: undefined,
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
        answerSource: "deterministic-fallback" as const,
        model: process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
        transport: "none" as const,
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

  const failedAgentResult = (
    id: AgentId,
    executionRole: AgentExecutionRole,
  ) => {
    const fallback = skippedAgentResult(id);
    return {
      ...fallback,
      selected: true,
      executionRole,
      selectionReason: "선택된 Agent 실행이 실패해 안전한 부분 결과로 처리했습니다.",
      summary: "Agent 실행을 완료하지 못해 중앙 모델이 이용할 근거가 없습니다.",
      report: undefined,
      edgeStatus: "insufficient-evidence" as const,
      inference: {
        ...fallback.inference,
        fallbackReason: "Agent execution failed",
        role: benchmarkMode ? "evidence-projection" as const : "agent-llm" as const,
      },
    };
  };

  const executeSelectedAgent = async (
    id: AgentId,
    executionRole: AgentExecutionRole,
  ) => {
    const taskId = `${runId}_${id}`;
    const retrievalQuery = mode === "remoterag" ? remoteRagQuery.query : groundedAnswersEnabled() ? sanitize(query).sanitized : `${query} ${retrievalFocus[id]}`;
    const requiredConceptIds = routerDecision ? conceptIdsForAgent(routerDecision, id) : [];
    let response: CoreEdgeAgentResponse;
    try {
      const scheduled = await scheduleAgentTask({
        requestId: runId,
        taskId,
        agentId: id,
        stage: benchmarkMode ? "agent-evidence-mapping" : "agent-inference",
        signal,
        execute: (scheduledSignal) => {
          report("agent.retrieving", `${agentProfiles[id].shortName} Agent가 Edge RAG 근거를 검색하고 로컬 응답을 생성하는 중입니다.`, {
            agentId: id,
            agentName: agentProfiles[id].name,
            executionRole,
          });
          return executeEdgeAgent({
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
            limits: { topK: groundedAnswersEnabled() ? groundedTopK() : 3, deadlineMs: 90_000 },
          }, scheduledSignal);
        },
      });
      response = scheduled.value;
    } catch (error) {
      settleCoordinatorTaskAfterError(runId, taskId, signal);
      if (signal?.aborted) throw error;
      return failedAgentResult(id, executionRole);
    }
    report("agent.retrieved", `${agentProfiles[id].shortName} Agent가 권한 필터를 통과한 근거 ${response.evidenceRefs.length}건을 준비했습니다.`, {
      agentId: id,
      agentName: agentProfiles[id].name,
      executionRole,
      evidenceCount: response.evidenceRefs.length,
    });
    report(benchmarkMode ? "agent.mapping" : "agent.generating", groundedAnswersEnabled()
      ? `${agentProfiles[id].shortName} Agent의 공개 근거와 응답 형식을 정리하는 중입니다.`
      : benchmarkMode
      ? `${agentProfiles[id].shortName} Agent가 원문 없이 근거 ID를 검증하는 중입니다.`
      : `${agentProfiles[id].shortName} Agent의 Edge 로컬 생성 결과를 검증하는 중입니다.`, {
        agentId: id,
        agentName: agentProfiles[id].name,
        executionRole,
      });

    const projected = projectEdgeEvidence(response);
    const summaryResult = sanitize(response.summary.text);
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
    requestCoordinator.transitionTask(taskId, "succeeded");
    report(benchmarkMode ? "agent.mapped" : "agent.completed", benchmarkMode
      ? `${agentProfiles[id].shortName} 전문 근거 매핑이 완료됐습니다.`
      : `${agentProfiles[id].shortName} Agent 응답 생성이 완료됐습니다.`, {
        agentId: id,
        agentName: agentProfiles[id].name,
        executionRole,
        evidenceCount: response.evidenceRefs.length,
        backend: benchmarkMode ? undefined : response.metrics.backend,
        model: benchmarkMode ? undefined : response.metrics.model,
      });
    const signalKeywords = agentProfiles[id].keywords
      .filter((keyword) => query.toLowerCase().includes(keyword.toLowerCase()))
      .slice(0, 3)
      .join("·");
    const completedResult = {
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
      question: questionFor(id),
      summary,
      report: buildAgentEvidenceReport({
        grounded: groundedAnswersEnabled(),
        agentId: id,
        agentName: agentProfiles[id].name,
        responsibility: agentProfiles[id].responsibility,
        executionRole,
        summary,
        evidenceIds: projected.evidence.map((item) => item.id),
        evidenceTitles: projected.evidence.map((item) => ({ id: item.id, title: item.title })),
      }),
      evidence: projected.evidence,
      evidencePlan: response.evidencePlan,
      edgeStatus: response.status,
      edgePolicyOutcome: response.policy.outcome,
      responsibility: agentProfiles[id].responsibility,
      filteredFields: [...new Set([...inputFiltered, ...summaryResult.filteredFields, ...projected.filteredFields])],
      latencyMs: response.metrics.latencyMs,
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
        answerSource: response.metrics.answerSource,
        model: response.metrics.model,
        ttftMs: response.metrics.ttftMs,
        tpotMs: response.metrics.tpotMs,
        tokensPerSecond: response.metrics.tokensPerSecond ?? null,
        promptTokens: response.metrics.promptTokens,
        completionTokens: response.metrics.completionTokens,
        totalMs: response.metrics.latencyMs,
        ...(response.status === "completed"
          ? {}
          : {
              fallbackReasonCode: response.metrics.fallbackReasonCode,
              fallbackReason: safeFallbackReason(response.metrics.fallbackReasonCode, response.status),
            }),
        role: benchmarkMode ? "evidence-projection" as const : "agent-llm" as const,
      },
    };
    return completedResult;
  };

  const executed = new Map<AgentId, Awaited<ReturnType<typeof executeSelectedAgent>>>();
  let adaptiveDecision: ReturnType<typeof planAdaptiveAdditions> | null = null;
  if (routerDecision) {
    const initialRoutingReviewRequired = routerDecision.humanReviewRequired;
    const primary = await executeSelectedAgent(routerDecision.primaryAgent, "primary");
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
      supportSelection: additions.map((agentId) => ({
        agentId,
        reason: routerDecision!.required.includes(agentId) ? "required-review" as const : "coverage-gap" as const,
        missingConceptIds: adaptiveDecision!.missingConceptIds.filter((conceptId) =>
          routerDecision!.requiredConcepts.some((concept) => concept.id === conceptId && concept.owner === agentId)),
      })),
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
    const completed = await Promise.all(selected.map((id) => executeSelectedAgent(id, "supporting")));
    completed.forEach((result) => executed.set(result.id, result));
  }
  for (const task of executionPlan.tasks) {
    if (task.kind === "agent" && task.status === "queued" && !executed.has(task.assignee as AgentId)) {
      requestCoordinator.transitionTask(task.taskId, "skipped");
    }
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
          modes: [...new Set(result.evidencePlan?.decisions.map((decision) => decision.appliedMode) ?? [])],
          transfers: result.evidencePlan?.decisions.map((decision) => ({
            referenceId: decision.referenceId,
            plannedMode: decision.plannedMode,
            appliedMode: decision.appliedMode,
            egressBytes: decision.egressBytes,
          })) ?? [],
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
  const demoSynthesis = demoSynthesisEnabled() ? publicDemoSynthesis(selectedResults) : null;
  const demoEvidenceInsufficient = demoSynthesis !== null && demoSynthesis.evidence.length === 0;
  if (demoEvidenceInsufficient) {
    for (const taskId of [`${runId}_central-integration`, `${runId}_managed-supervisor`]) {
      if (requestCoordinator.getTask(taskId)?.status === "queued") requestCoordinator.transitionTask(taskId, "skipped");
    }
  }
  const safeIntegrationEvidence: KnowledgeChunk[] = demoSynthesis?.evidence ?? selectedResults.map((result) => ({
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
  if (!demoEvidenceInsufficient && (benchmarkMode || mode === "proposed")) {
    const centralTaskId = `${runId}_central-integration`;
    const synthesisCallId = crypto.randomUUID();
    const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
    report("central.retrieved", `Edge에서 안전한 근거 참조 ${evidenceCount}건을 확보했습니다.`, {
      evidenceCount,
    });
    report("central.generating", mode === "proposed"
      ? "중앙 통합 모델이 주관·보조 Agent의 안전 요약과 근거 ID로 최종 응답을 생성하는 중입니다."
      : "중앙 모델이 안전한 요약과 근거 ID만으로 응답을 생성하는 중입니다.");
    try {
      const scheduled = await scheduleLocalLlmTask({
        requestId: runId,
        taskId: centralTaskId,
        agentId: "tech",
        taskKind: "central-integration",
        stage: "central-integration",
        signal,
        execute: async (scheduledSignal) => {
          const generated = await generateLocalAnswer({
      agent: "tech",
      agentName: mode === "proposed" ? "AXNetCC 중앙 통합 모델" : "중앙집중형 Core LLM",
      responsibility: mode === "proposed"
        ? "주관·보조 Agent가 반환한 안전 요약과 근거 식별자를 조정해 최종 응답 생성"
        : "Edge가 반환한 안전 요약과 근거 식별자만 중앙에서 통합 처리",
      query: mode === "remoterag" ? remoteRagQuery.query : query,
      evidence: safeIntegrationEvidence,
      fallback: selectedResults.map((result) => result.summary).join(" "),
      outputFormat: "integrated-report",
        signal: scheduledSignal,
        onAccountingFailure: (metrics) => markInferenceAccountingIncomplete(runId, "synthesis", { ...metrics, nodeId: process.env.DEMO_CORE_NODE_ID ?? null }, synthesisCallId),
        onMetrics: (metrics) => recordInferenceStage(runId, "synthesis", { ...metrics, nodeId: process.env.DEMO_CORE_NODE_ID ?? null }, synthesisCallId),
        });
          if (groundedAnswersEnabled() && generated.metrics.backend !== "ollama") {
            centralizedGeneration = generated;
            throw new Error("Grounded integration output rejected");
          }
          return generated;
        },
      });
      centralizedGeneration = scheduled.value;
      requestCoordinator.transitionTask(centralTaskId, "succeeded");
    } catch (error) {
      settleCoordinatorTaskAfterError(runId, centralTaskId, signal);
      if (signal?.aborted) throw error;
      centralizedGeneration ??= deterministicIntegrationFailure(
        selectedResults.map((result) => result.summary).join(" "),
        "Central integration execution failed",
      );
    }
  }
  if (demoEvidenceInsufficient) {
    report("central.integrating", "확인 가능한 공개 근거가 없어 모델 합성을 실행하지 않았습니다.");
  } else if (groundedAnswersEnabled()) {
    report("central.integrating", "전달된 공개 근거와 출처를 모아 응답을 구성하는 중입니다. 답변 의미의 자동 검증은 수행하지 않습니다.");
  } else if (mode === "managed") {
    report("central.integrating", "Managed Supervisor가 Agent 응답과 근거를 통합해 최종 응답을 생성하는 중입니다.");
  } else if (mode === "centralized" || mode === "remoterag") {
    report("central.integrating", "중앙 모델 응답과 전문영역별 근거의 정합성을 검증하는 중입니다.");
  } else if (mode === "proposed") {
    report("central.integrating", "중앙 통합 모델 응답의 필수 개념·근거·정책 정합성을 검증하는 중입니다.");
  } else {
    report("central.integrating", "Core Orchestrator가 Agent 응답의 근거·누락·충돌을 검증하는 중입니다.");
  }
  let managedSupervisor: Awaited<ReturnType<typeof generateLocalAnswer>> | null = null;
  if (!demoEvidenceInsufficient && mode === "managed") {
    const supervisorTaskId = `${runId}_managed-supervisor`;
    const supervisorCallId = crypto.randomUUID();
    try {
      const scheduled = await scheduleLocalLlmTask({
        requestId: runId,
        taskId: supervisorTaskId,
        agentId: "tech",
        taskKind: "managed-supervisor",
        stage: "managed-supervisor",
        signal,
        execute: async (scheduledSignal) => {
          const generated = await generateLocalAnswer({
          agent: "tech",
          agentName: "Managed Platform Supervisor",
          responsibility: "중앙 Supervisor가 Edge의 안전 요약과 근거 식별자만 통합",
          query,
          evidence: safeIntegrationEvidence,
          fallback: selectedResults.map((result) => result.summary).join(" "),
          outputFormat: "integrated-report",
          signal: scheduledSignal,
          onAccountingFailure: (metrics) => markInferenceAccountingIncomplete(runId, "supervisor", { ...metrics, nodeId: process.env.DEMO_CORE_NODE_ID ?? null }, supervisorCallId),
          onMetrics: (metrics) => recordInferenceStage(runId, "supervisor", { ...metrics, nodeId: process.env.DEMO_CORE_NODE_ID ?? null }, supervisorCallId),
        });
          if (groundedAnswersEnabled() && generated.metrics.backend !== "ollama") {
            managedSupervisor = generated;
            throw new Error("Grounded integration output rejected");
          }
          return generated;
        },
      });
      managedSupervisor = scheduled.value;
      requestCoordinator.transitionTask(supervisorTaskId, "succeeded");
    } catch (error) {
      settleCoordinatorTaskAfterError(runId, supervisorTaskId, signal);
      if (signal?.aborted) throw error;
      managedSupervisor ??= deterministicIntegrationFailure(
        selectedResults.map((result) => result.summary).join(" "),
        "Managed Supervisor execution failed",
      );
    }
  }
  const evidenceCount = selectedResults.reduce((sum, result) => sum + result.evidence.length, 0);
  const requiresSecurity = /개인|민감|내부|보안|민원|데이터/i.test(query);
  const requiresLegal = /법|계약|책임|위탁|개인/i.test(query);
  const missing = [
    requiresSecurity && !selected.includes("security") ? "보안" : "",
    requiresLegal && !selected.includes("legal") ? "법무" : "",
  ].filter(Boolean);
  const encoder = new TextEncoder();
  const centralizedSourceBytes = selectedResults.reduce(
    (sum, result) => sum + result.edgeMetrics.sourceBytesProcessed,
    0,
  );
  const validEvidenceIds = new Set(selectedResults.flatMap((result) => result.evidence.map((item) => item.id)));
  const integrationEvidenceIds = demoSynthesis ? new Set(safeIntegrationEvidence.map(item => item.id)) : validEvidenceIds;
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
  const allInferenceResults = [
    ...selectedResults
      .filter((result) => result.inference.role === "agent-llm")
      .map((result) => result.inference),
    ...(centralizedGeneration ? [centralizedGeneration.metrics] : []),
    ...(managedSupervisor ? [managedSupervisor.metrics] : []),
  ];
  const tokenReading = aggregateInferenceTokenCounts(allInferenceResults);
  const defaultConclusion = "제한적 시범 도입을 권고합니다. 원문 데이터의 조직 내 보존, 역할 기반 접근통제, 담당자 최종 검토를 선행조건으로 설정하고 PoC 이후 품질·보안·비용 지표를 재평가해야 합니다.";
  const integratedGeneration = managedSupervisor ?? centralizedGeneration;
  const integratedRawConclusion = integratedGeneration
    ? demoSynthesis
      ? filterDemoSynthesisCitations(integratedGeneration.text, integrationEvidenceIds)
      : enforceEvidenceCitation(integratedGeneration.text, [...integrationEvidenceIds])
    : demoEvidenceInsufficient
      ? "확인 가능한 공개 근거가 부족하여 답변을 생성하지 않았습니다. Agent 연결 상태와 공개 근거를 확인한 뒤 다시 요청해 주세요."
      : groundedAnswersEnabled() ? groundedUnavailable() : defaultConclusion;
  const { sanitized: conclusion } = sanitize(integratedRawConclusion);
  const reportTitle = "신규 AI 서비스 도입 종합 검토보고서";
  const primaryAgentId = routerDecision?.primaryAgent ?? selectedResults[0]?.id ?? "tech";
  const integratedReport = buildIntegratedEvidenceReport({
    preserveConclusionCitations: Boolean(demoSynthesis),
    grounded: groundedAnswersEnabled(),
    title: reportTitle,
    conclusion,
    primaryAgentId,
    agents: selectedResults
      .filter((agent) => agent.report)
      .map((agent) => ({
        id: agent.id,
        report: agent.report!,
        evidenceIds: agent.evidence.map((item) => item.id).filter(id => integrationEvidenceIds.has(id)),
      })),
  });
  const integration = managedSupervisor
    ? {
        actor: "managed-supervisor" as const,
        label: "Managed Platform Supervisor",
        backend: managedSupervisor.metrics.backend,
        answerSource: managedSupervisor.metrics.answerSource,
        ...(managedSupervisor.metrics.fallbackReason
          ? { fallbackReason: managedSupervisor.metrics.fallbackReason }
          : {}),
        model: managedSupervisor.metrics.model,
      }
    : centralizedGeneration
      ? {
          actor: "central-llm" as const,
          label: mode === "proposed" ? "AXNetCC 중앙 통합 모델" : "중앙집중형 Core LLM",
          backend: centralizedGeneration.metrics.backend,
          answerSource: centralizedGeneration.metrics.answerSource,
          ...(centralizedGeneration.metrics.fallbackReason
            ? { fallbackReason: centralizedGeneration.metrics.fallbackReason }
            : {}),
          model: centralizedGeneration.metrics.model,
        }
      : {
          actor: "core-orchestrator" as const,
          label: "Core Orchestrator",
          backend: "deterministic" as const,
          answerSource: "deterministic-fallback" as const,
          fallbackReason: demoEvidenceInsufficient
            ? "Insufficient approved public evidence; synthesis not attempted"
            : "No integration LLM was scheduled for this mode",
          model: null,
        };
  const integratedEvidenceText = demoSynthesis
    ? safeIntegrationEvidence.map(item => item.text.slice(0, 800)).join(" ")
    : selectedResults.flatMap((result) => result.evidence).map(item => item.excerpt).join(" ");
  const integratedCitations = [...conclusion.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  const integratedValidCitations = integratedCitations.filter((id) => integrationEvidenceIds.has(id));
  const integratedCitationValidity = integratedCitations.length
    ? Math.round(integratedValidCitations.length / integratedCitations.length * 100)
    : 0;
  const integratedCitationRecall = Math.round(
    new Set(integratedValidCitations).size / Math.max(integrationEvidenceIds.size, 1) * 100,
  );
  const integratedClaims = conclusion
    .split(/\n+|(?<=[.!?다요])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => terms(sentence.replace(/\[[^\]]+\]/g, "")).length >= 3);
  const integratedClaimSupport = Math.round(
    integratedClaims.filter((sentence) =>
      [...sentence.matchAll(/\[([^\]]+)\]/g)].some((match) => integrationEvidenceIds.has(match[1])),
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
        const judgeTaskId = `${runId}_commercial-judge`;
        report("judge.evaluating", "상용 LLM이 답변 품질을 블라인드 평가하는 중입니다.");
        try {
          const scheduled = await scheduleCommercialJudgeTask({
            requestId: runId,
            taskId: judgeTaskId,
            stage: "commercial-judge",
            signal,
            execute: (scheduledSignal) => evaluateWithCommercialJudge({
              query,
              answer: conclusion,
              evidence: selectedResults.flatMap((result) =>
                result.evidence.map((item) => `[${item.id}] classification=${item.classification}`),
              ).join("\n"),
              signal: scheduledSignal,
            }),
          });
          const judged = scheduled.value;
          requestCoordinator.transitionTask(judgeTaskId, judged.error ? "failed" : "succeeded");
          report("judge.completed", judged.error ? "상용 LLM 평가를 완료하지 못했습니다." : "상용 LLM 품질 평가가 완료됐습니다.");
          return judged;
        } catch (error) {
          settleCoordinatorTaskAfterError(runId, judgeTaskId, signal);
          if (signal?.aborted) throw error;
          return {
            enabled: true,
            provider: "configured",
            error: "Commercial judge execution failed",
          };
        }
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
  const egressEnvelopes: EgressEnvelope[] = selectedResults.map((agent) => ({
      id: `${runId}:edge:${agent.id}`,
      recipientId: `edge-agent:${agent.id}`,
      channel: "edge-agent" as const,
      leavesBoundary: agent.policy.edgeMode === "remote",
      payloadBytes: agent.edgeMetrics.egressBytes,
      byteSource: "measured-contract" as const,
      disclosures: [{
        sourceId: "user-input",
        mode: agent.policy.edgeMode === "remote" ? "masked" as const : "none" as const,
      }],
    }));
  const integrationGenerationForPrivacy = managedSupervisor ?? centralizedGeneration;
  if (integrationGenerationForPrivacy?.metrics.transport === "remote") {
    const integrationPayloadBytes = encoder.encode(JSON.stringify({
      query,
      evidence: safeIntegrationEvidence.map((item) => ({
        id: item.id,
        classification: item.classification,
        text: item.text,
      })),
    })).length;
    egressEnvelopes.push({
      id: `${runId}:central-llm`,
      recipientId: `central-llm:${integrationGenerationForPrivacy.metrics.model}`,
      channel: "central-llm",
      leavesBoundary: true,
      payloadBytes: integrationPayloadBytes,
      byteSource: "derived-safe-payload",
      disclosures: [{ sourceId: "user-input", mode: "masked" }],
    });
  }
  if (commercialJudge.enabled) {
    const judgePayloadBytes = encoder.encode(JSON.stringify({
      query,
      answer: conclusion,
      evidence: selectedResults.flatMap((agent) => agent.evidence.map((item) => ({
        id: item.id,
        classification: item.classification,
      }))),
    })).length;
    egressEnvelopes.push({
      id: `${runId}:commercial-judge`,
      recipientId: `commercial-judge:${commercialJudge.provider}`,
      channel: "commercial-judge",
      leavesBoundary: true,
      payloadBytes: judgePayloadBytes,
      byteSource: "derived-safe-payload",
      disclosures: [{ sourceId: "user-input", mode: "masked" }],
    });
  }
  const boundaryBytes = egressEnvelopes.reduce(
    (sum, envelope) => sum + (envelope.payloadBytes ?? 0),
    0,
  );
  const minimizationRate = centralizedSourceBytes > 0
    ? Math.max(0, Math.round((1 - boundaryBytes / centralizedSourceBytes) * 100))
    : null;
  const privacyRisk = calculatePrivacyRiskV2({
    protectedSources: [{ id: "user-input", kind: "user-input", text: rawQuery.trim() }],
    egressEnvelopes,
    selectedAgentIds: selected,
    totalAgentCount: ids.length,
    outputTexts: [conclusion, ...selectedResults.map((agent) => agent.summary)],
  });
  const traceabilityReading = calculateCitationTraceability(conclusion, integrationEvidenceIds);
  const conflictAnalysis = detectExplicitClaimConflicts(
    selectedResults.map((agent) => ({ agentId: agent.id, text: agent.summary })),
  );
  const execution = requestCoordinator.getRequest(runId);
  if (!execution) throw new Error(`Execution state not found for ${runId}`);
  const schedulerMetrics = executionMetricsForRequest(runId);
  const schedulerMetricsByTask = new Map(
    schedulerMetrics.map((metrics) => [metrics.taskId, metrics]),
  );
  const executionTasks = execution.taskIds
    .map((taskId) => {
      const task = requestCoordinator.getTask(taskId);
      return task
        ? { ...task, scheduler: schedulerMetricsByTask.get(taskId) ?? null }
        : null;
    })
    .filter((task) => task !== null);
  const elapsedReading = calculateElapsedMetric(startedAt, Date.now());
  const aggregateQueueWaitMs = schedulerMetrics.reduce((sum, item) => sum + item.queueWaitMs, 0);
  const aggregateInferenceMs = schedulerMetrics.reduce((sum, item) => sum + item.inferenceMs, 0);
  const callsReading = derivedMetric(allInferenceResults.length, {
    source: "scheduled inference results",
    method: "count Agent and central/Supervisor inference results; evidence-only mapping is excluded",
  });
  const boundaryBytesReading = derivedMetric(boundaryBytes, {
    source: "boundary.egressLedger.v2.envelopes.payloadBytes",
    method: "sum every measured-contract and derived-safe-payload byte count",
  });
  const exposedFieldsReading = derivedMetric(Math.ceil(privacyRisk.sensitiveTransmittedCount), {
    source: "boundary.egressLedger.v2 disclosures",
    method: "ceil privacy-risk-v2 sensitive transmitted occurrence equivalents",
  });
  const rawDataLeavesEdgeReading = derivedMetric(privacyRisk.rawDataLeavesEdge, {
    source: "boundary.egressLedger.v2 disclosures",
    method: "true when any protected-source original byte crosses a physical trust boundary",
  });
  const queueWaitReading = derivedMetric(aggregateQueueWaitMs, {
    source: "endpoint scheduler task audit",
    method: "sum task queueWaitMs for this request",
  });
  const inferenceTimeReading = derivedMetric(aggregateInferenceMs, {
    source: "endpoint scheduler task audit",
    method: "sum task inferenceMs for this request",
  });
  const reviewStatus = missing.length ||
    evidencePlan?.humanReviewRequired ||
    conflictAnalysis.status === "detected" ||
    execution.status === "partial_failed" ||
    execution.status === "failed"
    ? "review" as const
    : "ready" as const;

  const result = {
    runId,
    requestId: runId,
    mode,
    title: reportTitle,
    conclusion,
    report: integratedReport,
    integration,
    routerDecision,
    evidencePlan,
    status: reviewStatus,
    reviewStatus,
    executionStatus: demoEvidenceInsufficient && execution.status === "completed" ? "partial_failed" : execution.status,
    execution: {
      requestId: execution.requestId,
      executionStatus: demoEvidenceInsufficient && execution.status === "completed" ? "partial_failed" : execution.status,
      totalCount: execution.progress.total,
      terminalCount: execution.progress.total - execution.progress.remaining,
      remainingCount: execution.progress.remaining,
      version: execution.version,
      tasks: executionTasks,
      persistence: "single-process-memory" as const,
      scheduling: {
        authority: "single-process-memory" as const,
        policy: "fifo-last-task-aging-deadline" as const,
        scheduledTaskCount: schedulerMetrics.length,
      },
    },
    agents: agentResults,
    boundary: {
      transport: boundaryTransport,
      corePayloadFields: [...corePayloadFields],
      blockedDocuments,
      rawContentReturned: false as const,
      policyVersion: "edge-rag-v1",
      egressLedger: {
        version: "v2",
        envelopeCount: egressEnvelopes.length,
        recipients: [...new Set(
          egressEnvelopes
            .filter((envelope) => envelope.leavesBoundary)
            .map((envelope) => envelope.recipientId),
        )],
        totalPayloadBytes: boundaryBytes,
        envelopes: egressEnvelopes.map((envelope) => ({
          id: envelope.id,
          recipientId: envelope.recipientId,
          channel: envelope.channel,
          leavesBoundary: envelope.leavesBoundary,
          payloadBytes: envelope.payloadBytes ?? 0,
          byteSource: envelope.byteSource ?? "derived-safe-payload",
          disclosures: envelope.disclosures.map((disclosure) => ({
            sourceId: disclosure.sourceId,
            mode: disclosure.mode,
            originalRangeCount: disclosure.originalRanges?.length ?? 0,
          })),
        })),
      },
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
      {
        label: "응답 충돌",
        status: conflictAnalysis.status === "detected" ? "warn" : "pass",
        detail: conflictAnalysis.status === "detected"
          ? `명시적 허용·금지 충돌 ${conflictAnalysis.conflicts.length}건을 검토해야 합니다.`
          : conflictAnalysis.status === "not-evaluable"
            ? "명시적 허용·금지 문장이 없어 자동 판정하지 않았습니다."
            : "보수적 명시 규칙에서 충돌이 탐지되지 않았습니다(의미론적 무충돌을 보장하지 않음).",
      },
      { label: "민감정보", status: "pass", detail: inputFiltered.length ? `${inputFiltered.join("·")} 입력을 마스킹했습니다.` : "직접 식별자가 발견되지 않았습니다." },
    ],
    metrics: {
      calls: callsReading.value,
      agentCalls: selectedResults.filter((result) => result.inference.role === "agent-llm").length,
      integrationCalls: Number(Boolean(centralizedGeneration)) + Number(Boolean(managedSupervisor)),
      tokens: tokenReading.value?.totalTokens ?? null,
      tokenBreakdown: tokenReading.value,
      bytes: boundaryBytes,
      latencyMs: elapsedReading.value,
      latencyBreakdown: {
        queueWaitMs: queueWaitReading.value,
        inferenceMs: inferenceTimeReading.value,
        endToEndMs: elapsedReading.value,
        aggregation: "task-sum/task-sum/request-wall-clock" as const,
      },
      exposedFields: exposedFieldsReading.value,
      traceability: traceabilityReading.value?.score ?? null,
      traceabilityDetail: traceabilityReading.value,
      rawDataLeavesEdge: privacyRisk.rawDataLeavesEdge,
      boundaryBytes,
      dataRecipients: privacyRisk.recipientCount,
      minimizationRate,
      privacyRiskScore: privacyRisk.score,
      privacyRiskVersion: privacyRisk.privacyRiskVersion,
      privacyRisk,
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
      llmBackend: !demoEvidenceInsufficient && allInferenceResults.length > 0 && allInferenceResults.every((result) => result.backend === "ollama") ? "ollama" : "deterministic",
      model: integration.model ?? selectedResults[0]?.inference.model ?? process.env.LOCAL_LLM_MODEL ?? "qwen2.5:3b",
      ttftMs: (() => {
        const values = allInferenceResults
          .map((result) => result.ttftMs)
          .filter((value): value is number => value !== null);
        return values.length ? Math.min(...values) : null;
      })(),
      tpotMs: (() => {
        const values = allInferenceResults
          .map((result) => result.tpotMs)
          .filter((value): value is number => value !== null);
        return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
      })(),
      provenance: {
        version: METRIC_PROVENANCE_VERSION,
        fields: {
          calls: callsReading.provenance,
          tokens: tokenReading.provenance,
          latencyMs: elapsedReading.provenance,
          queueWaitMs: queueWaitReading.provenance,
          inferenceMs: inferenceTimeReading.provenance,
          boundaryBytes: boundaryBytesReading.provenance,
          exposedFields: exposedFieldsReading.provenance,
          rawDataLeavesEdge: rawDataLeavesEdgeReading.provenance,
          traceability: traceabilityReading.provenance,
          privacyRiskScore: derivedMetric(privacyRisk.score, {
            source: "privacy-risk-v2 S/A/O breakdown",
            method: "round(100 * (0.5S + 0.3A + 0.2O))",
          }).provenance,
          sensitiveTransmissionRatio: derivedMetric(privacyRisk.sensitiveTransmissionRatio, {
            source: "boundary.egressLedger.v2 disclosures",
            method: "sensitive transmitted occurrence equivalents / detected occurrences",
          }).provenance,
          agentSelectionRatio: derivedMetric(privacyRisk.agentSelectionRatio, {
            source: "Boundary Router selected Agent IDs",
            method: "deduplicated selected Agents / eligible Agents",
          }).provenance,
          originalDisclosureRatio: derivedMetric(privacyRisk.originalDisclosureRatio, {
            source: "boundary.egressLedger.v2 protected-source ranges",
            method: "unique disclosed original UTF-8 bytes / protected source UTF-8 bytes",
          }).provenance,
        },
      },
      conflictAnalysis,
    },
    commercialJudge,
    timeline: schedulerMetrics.length
      ? schedulerMetrics.map((item) => ({
          label: `${item.taskKind} · ${item.agentId}`,
          detail: `${item.dispatchReason} · ${item.outcome}`,
          ms: item.endToEndMs,
          queueWaitMs: item.queueWaitMs,
          inferenceMs: item.inferenceMs,
          provenance: "measured" as const,
        }))
      : [{
          label: "요청 전체",
          detail: "scheduler task가 없어 wall-clock만 기록",
          ms: elapsedReading.value ?? 0,
          queueWaitMs: null,
          inferenceMs: null,
          provenance: elapsedReading.provenance.kind,
        }],
  };
  report("central.completed", groundedAnswersEnabled() && result.executionStatus !== "completed"
    ? `${integration.label}의 최종 통합에 실패했습니다. 최종 답변을 확정하지 못했습니다.`
    : `${integration.label}의 최종 통합이 완료됐습니다.`, {
    backend: integration.backend,
    model: integration.model ?? undefined,
    evidenceCount,
  });
  report("request.completed", groundedAnswersEnabled()
    ? result.executionStatus === "completed" ? "최종 응답과 출처·실행 지표 생성이 완료됐습니다." : "최종 답변을 확정하지 못했습니다. 실패 상태와 출처·실행 지표를 표시합니다."
    : "최종 응답과 검증 지표 생성이 완료됐습니다.", {
    evidenceCount,
  });
  return result;
}
