"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isRunStartStalled } from "../lib/run-observation";

type RouterDecisionView = {
  version: "2";
  strategy: "boundary-constrained";
  securityLevel: "public" | "internal" | "confidential" | "personal";
  purpose: "advice" | "decision" | "audit";
  primaryAgent: string;
  candidateAgents: string[];
  required: string[];
  selected: string[];
  supportingAgents: string[];
  requiredConcepts: Array<{ id: string; label: string; owner: string; aliases: string[] }>;
  predictedCoverage: number;
  objectiveCost: number;
  adaptiveAdditions: string[];
  humanReviewRequired: boolean;
  rationale: string[];
  primarySelection?: {
    algorithm: string;
    hardGate: {
      applied: boolean;
      forcedAgent?: string;
      reasons: string[];
    };
    rankedCandidates: Array<{
      agentId: string;
      rank: number;
      totalScore: number;
      components: {
        profileSimilarity?: number;
        keywordEntity?: number;
        evidenceReadiness?: number;
        missRisk?: number;
        costEfficiency?: number;
        domainSignal?: number;
      };
      matchedTerms?: string[];
      matchedEntities?: string[];
      matchedConceptIds?: string[];
    }>;
    confidence: number;
    top1Top2Margin: number;
    decisionThreshold: number;
    fallbackUsed: boolean;
    fallbackReason?: string;
    reviewReasons: string[];
  };
};

type EvidencePlanView = {
  coverage: number | null;
  coveredConceptIds: string[];
  missingConceptIds: string[];
  humanReviewRequired: boolean;
  agentPlans: Array<{
    agentId: string;
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

type MetricProvenanceView = {
  version: "v2";
  kind: "measured" | "derived" | "estimated" | "unavailable";
  source: string;
  method: string;
  detail?: string;
};

type ReportPriority = "high" | "medium" | "low";

type ReportFinding = {
  title: string;
  content: string;
  citations: string[];
};

type ReportRecommendation = {
  content: string;
  priority: ReportPriority;
  citations: string[];
};

type AgentEvidenceReport = {
  version: "1";
  title: string;
  executiveSummary: string;
  findings: ReportFinding[];
  recommendations: ReportRecommendation[];
  limitations: string[];
  citationIds: string[];
};

type IntegratedEvidenceReport = {
  version: "1";
  title: string;
  executiveSummary: string;
  primaryAgentId: string;
  participatingAgentIds: string[];
  sections: Array<ReportFinding & { sourceAgentIds: string[] }>;
  recommendations: ReportRecommendation[];
  limitations: string[];
  references: Array<{ evidenceId: string; agentId: string }>;
};

type AgentResult = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  selected: boolean;
  executionRole?: "primary" | "required-reviewer" | "supporting" | "not-selected";
  selectionReason?: string;
  score: number;
  question: string;
  summary: string;
  report?: AgentEvidenceReport;
  evidence: {
    id: string;
    title: string;
    excerpt: string;
    sourceUrl?: string;
    effectiveDate?: string;
    classification?: "public" | "internal" | "confidential";
    disclosure?: "reference-only" | "sanitized-preview";
  }[];
  audit?: {
    allowedClasses: Array<"public" | "internal" | "confidential">;
    returnedClasses: Array<"public" | "internal" | "confidential">;
    blockedCount: number;
    policyDecisionId: string;
    edgeMode: string;
  };
  responsibility: string;
  filteredFields: string[];
  latencyMs: number;
  inference?: {
    backend: "ollama" | "deterministic";
    answerSource?: "local-llm" | "deterministic-fallback";
    model: string;
    role?: "agent-llm" | "evidence-projection" | "not-selected";
    ttftMs: number | null;
    tpotMs: number | null;
    fallbackReason?: string;
  };
};

type RunResult = {
  runId: string;
  mode:
    | "proposed"
    | "parallel"
    | "centralized"
    | "managed"
    | "masrouter"
    | "remoterag";
  title: string;
  conclusion: string;
  report?: IntegratedEvidenceReport;
  integration?: {
    actor: "core-orchestrator" | "central-llm" | "managed-supervisor";
    label: string;
    backend: "ollama" | "deterministic";
    answerSource?: "local-llm" | "deterministic-fallback";
    fallbackReason?: string;
    fallbackReasonCode?: string;
    model: string | null;
  };
  status: "ready" | "review";
  routerDecision?: RouterDecisionView | null;
  evidencePlan?: EvidencePlanView | null;
  agents: AgentResult[];
  checks: { label: string; status: "pass" | "warn"; detail: string }[];
  metrics: {
    calls: number | null;
    agentCalls?: number;
    integrationCalls?: number;
    tokens: number | null;
    tokenBreakdown?: {
      inferenceCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    } | null;
    bytes: number;
    latencyMs: number | null;
    latencyBreakdown?: {
      queueWaitMs: number | null;
      inferenceMs: number | null;
      endToEndMs: number | null;
      aggregation: string;
    };
    exposedFields: number | null;
    traceability: number | null;
    rawDataLeavesEdge: boolean;
    boundaryBytes: number;
    dataRecipients: number;
    minimizationRate: number | null;
    privacyRiskScore: number;
    privacyRiskVersion?: "v2";
    privacyRisk?: {
      privacyRiskVersion: "v2";
      score: number;
      sensitiveDetectedCount: number;
      sensitiveTransmittedCount: number;
      sensitiveTransmissionRatio: number;
      selectedAgentCount: number;
      totalAgentCount: number;
      agentSelectionRatio: number;
      originalBytes: number;
      transmittedOriginalBytes: number;
      originalDisclosureRatio: number;
      egressEnvelopeCount: number;
      recipientCount: number;
      privacyPass: boolean;
      outputLeak: boolean;
      diagnostics: string[];
    };
    groundedness: number;
    relevance: number;
    evidenceSupport: number;
    citationCoverage: number;
    citationValidity: number;
    citationRecall?: number;
    claimSupportRate?: number;
    retrievalSuccessRate?: number;
    evidenceUtilizationRate?: number;
    claimCitationCoverage?: number;
    domainCoverage: number;
    answerCompleteness: number;
    qualityScore: number;
    ragChunks?: number;
    llmBackend?: "ollama" | "deterministic";
    model?: string;
    ttftMs?: number | null;
    tpotMs?: number | null;
    provenance?: {
      version: "v2";
      fields: Record<string, MetricProvenanceView>;
    };
  };
  commercialJudge?: {
    enabled: boolean;
    provider: string;
    model?: string;
    correctness?: number;
    groundedness?: number;
    completeness?: number;
    overall?: number;
    rationale?: string;
    error?: string;
  };
  boundary?: {
    transport: string;
    corePayloadFields: string[];
    blockedDocuments: number;
    rawContentReturned: false;
    policyVersion?: string;
  };
  timeline: {
    label: string;
    detail: string;
    ms: number;
    queueWaitMs?: number | null;
    inferenceMs?: number | null;
    provenance?: MetricProvenanceView["kind"];
  }[];
};

type LlmHealth = {
  status: "connected" | "degraded" | "disconnected";
  connected: number;
  total: number;
  model: string;
};

type ProgressEvent = {
  runId: string;
  mode: RunResult["mode"];
  stage:
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
  message: string;
  timestamp: number;
  sequence: number;
  agentId?: string;
  agentName?: string;
  selectedAgents?: string[];
  executionRole?: "primary" | "required-reviewer" | "supporting";
  routerDecision?: RouterDecisionView;
  evidencePlan?: EvidencePlanView;
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

type RunApiTask = {
  taskId: string;
  kind: "agent" | "central-integration" | "managed-supervisor" | "commercial-judge";
  assignee: string;
  required: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  queuePosition: number | null;
  waitingMs: number;
};

type RunApiSnapshot = {
  requestId: string;
  mode: RunResult["mode"];
  status: "queued" | "running" | "integrating" | "completed" | "partial_failed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  latestStage: string | null;
  lastEventId: number;
  progress: {
    totalCount: number;
    terminalCount: number;
    remainingCount: number;
  };
  tasks: RunApiTask[];
  result?: RunResult;
  errorCode?: string;
};

class RunApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.name = "RunApiError";
    this.status = status;
    this.code = code;
  }
}

type LiveAgentStage =
  | "idle"
  | "queued"
  | "retrieving"
  | "retrieved"
  | "generating"
  | "mapping"
  | "completed"
  | "mapped"
  | "fallback"
  | "skipped"
  | "error";

type LiveCoreStage =
  | "routing"
  | "retrieving"
  | "generating"
  | "integrating"
  | "judging"
  | "completed"
  | "error";

type LiveAgentState = {
  selected: boolean | null;
  stage: LiveAgentStage;
  message: string;
  evidenceCount: number;
  backend?: "ollama" | "deterministic";
  model?: string;
  queuePosition?: number | null;
  waitingMs?: number;
};

type LiveRunState = {
  runId?: string;
  mode: RunResult["mode"];
  sequence: number;
  message: string;
  core: {
    kind: "core-orchestrator" | "central-llm" | "managed-supervisor";
    stage: LiveCoreStage;
    message: string;
    evidenceCount: number;
    backend?: "ollama" | "deterministic";
    model?: string;
  };
  routerDecision?: RouterDecisionView;
  evidencePlan?: EvidencePlanView;
  agents: Record<string, LiveAgentState>;
  activity: Array<{ sequence: number; message: string }>;
  execution: {
    status: RunApiSnapshot["status"];
    totalCount: number;
    terminalCount: number;
    remainingCount: number;
  };
};

type LiveRunAction =
  | { type: "reset"; mode: RunResult["mode"]; label?: string }
  | { type: "event"; event: ProgressEvent }
  | { type: "snapshot"; snapshot: RunApiSnapshot }
  | { type: "error"; message: string };

const agents = [
  { id: "tech", name: "기술검토 Agent", shortName: "기술", color: "#5B8CFF", detail: "아키텍처·운용·성능" },
  { id: "data", name: "데이터거버넌스 Agent", shortName: "데이터", color: "#31B7C2", detail: "품질·수명주기·메타데이터" },
  { id: "security", name: "보안 Agent", shortName: "보안", color: "#45D6B5", detail: "정보보호·접근권한" },
  { id: "legal", name: "법무 Agent", shortName: "법무", color: "#AA88FF", detail: "법령·계약·책임" },
  { id: "policy", name: "정책·윤리 Agent", shortName: "정책", color: "#D57BEA", detail: "공공성·투명성·영향평가" },
  { id: "finance", name: "재무 Agent", shortName: "재무", color: "#FFB25B", detail: "예산·조달·비용" },
  { id: "procurement", name: "조달·계약 Agent", shortName: "조달", color: "#F58B55", detail: "발주·경쟁성·종속성" },
  { id: "operations", name: "운영·품질 Agent", shortName: "운영", color: "#84B65A", detail: "SLA·장애·품질측정" },
];

const modeLabels: Record<RunResult["mode"], string> = {
  proposed: "데이터 경계 인지 오케스트레이션",
  parallel: "전체 Agent 병렬 호출",
  centralized: "중앙집중 처리",
  managed: "Managed Supervisor 통합",
  masrouter: "MasRouter-inspired 역할 라우팅",
  remoterag: "RemoteRAG-inspired 보호 검색",
};

function liveCoreKind(mode: RunResult["mode"]): LiveRunState["core"]["kind"] {
  if (mode === "managed") return "managed-supervisor";
  if (mode === "proposed" || mode === "centralized" || mode === "remoterag") return "central-llm";
  return "core-orchestrator";
}

function createLiveRunState(mode: RunResult["mode"], label?: string): LiveRunState {
  return {
    mode,
    sequence: 0,
    message: label ? `${label} 실행을 준비하고 있습니다.` : "실행을 준비하고 있습니다.",
    core: {
      kind: liveCoreKind(mode),
      stage: "routing",
      message: "요청 정제와 Agent 라우팅을 준비하고 있습니다.",
      evidenceCount: 0,
    },
    agents: Object.fromEntries(agents.map((agent) => [
      agent.id,
      {
        selected: null,
        stage: "idle" as const,
        message: "라우팅 대기 중",
        evidenceCount: 0,
      },
    ])),
    activity: [],
    execution: {
      status: "queued",
      totalCount: 0,
      terminalCount: 0,
      remainingCount: 0,
    },
  };
}

function liveRunReducer(state: LiveRunState, action: LiveRunAction): LiveRunState {
  if (action.type === "reset") return createLiveRunState(action.mode, action.label);
  if (action.type === "error") {
    return {
      ...state,
      message: action.message,
      core: { ...state.core, stage: "error", message: action.message },
    };
  }

  if (action.type === "snapshot") {
    const snapshot = action.snapshot;
    let nextAgents = state.agents;
    let nextCore = state.core;
    let nextMessage = state.message;
    for (const task of snapshot.tasks) {
      if (task.kind === "agent") {
        const current = nextAgents[task.assignee];
        if (!current) continue;
        const stage: LiveAgentStage = task.status === "queued"
          ? "queued"
          : task.status === "running"
            ? current.stage === "queued" || current.stage === "idle" ? "retrieving" : current.stage
            : task.status === "succeeded"
              ? ["completed", "mapped", "fallback"].includes(current.stage) ? current.stage : "completed"
              : task.status === "skipped"
                ? "skipped"
                : "error";
        nextAgents = {
          ...nextAgents,
          [task.assignee]: {
            ...current,
            selected: task.status !== "skipped",
            stage,
            queuePosition: task.queuePosition,
            waitingMs: task.waitingMs,
            message: task.status === "queued"
              ? `실행 대기 중${task.queuePosition ? ` · Queue ${task.queuePosition}번` : ""}`
              : task.status === "running" && (current.stage === "queued" || current.stage === "idle")
                ? "RAG 근거를 검색하고 응답을 생성하는 중"
              : current.message,
          },
        };
      } else {
        const isJudge = task.kind === "commercial-judge";
        const isSupervisor = task.kind === "managed-supervisor";
        const actor = isJudge ? "상용 LLM 평가" : isSupervisor ? "Managed Supervisor" : "중앙 모델";
        if (task.status === "queued") {
          nextMessage = `${actor}가 Agent 결과를 기다리는 중입니다.`;
          nextCore = { ...nextCore, message: nextMessage };
        } else if (task.status === "running") {
          nextMessage = isJudge
            ? "상용 LLM이 최종 응답을 평가하는 중입니다."
            : `${actor}가 근거와 Agent 응답을 통합해 최종 응답을 생성하는 중입니다.`;
          nextCore = {
            ...nextCore,
            stage: isJudge ? "judging" : "integrating",
            message: nextMessage,
          };
        } else if (task.status === "succeeded") {
          nextMessage = `${actor} 처리가 완료되었습니다.`;
          nextCore = {
            ...nextCore,
            stage: isJudge || snapshot.status === "completed" || snapshot.status === "partial_failed"
              ? "completed"
              : nextCore.stage,
            message: nextMessage,
          };
        } else if (task.status === "failed" || task.status === "cancelled") {
          nextMessage = `${actor} 처리 단계가 종료되었습니다.`;
          nextCore = { ...nextCore, stage: "error", message: nextMessage };
        }
      }
    }
    if (snapshot.status === "integrating" && nextCore.stage !== "judging") {
      nextMessage = nextCore.message === state.core.message
        ? "중앙 모델이 근거와 응답을 통합하는 중입니다."
        : nextMessage;
      nextCore = { ...nextCore, stage: "integrating", message: nextMessage };
    }
    return {
      ...state,
      runId: snapshot.requestId,
      mode: snapshot.mode,
      message: nextMessage,
      agents: nextAgents,
      core: nextCore,
      execution: {
        status: snapshot.status,
        totalCount: snapshot.progress.totalCount,
        terminalCount: snapshot.progress.terminalCount,
        remainingCount: snapshot.progress.remainingCount,
      },
    };
  }

  const event = action.event;
  if (state.runId && state.runId !== event.runId) return state;
  if (event.sequence <= state.sequence) return state;

  let nextAgents = state.agents;
  let nextCore = state.core;
  if (event.stage === "agents.selected" || event.stage === "agents.adapted") {
    const selected = new Set(event.selectedAgents ?? []);
    nextAgents = Object.fromEntries(agents.map((agent) => [
      agent.id,
      (() => {
        const current = state.agents[agent.id];
        const isSelected = selected.has(agent.id);
        const newlySelected = isSelected && current.selected !== true;
        return {
          ...current,
          selected: isSelected,
          stage: newlySelected ? "queued" : isSelected ? current.stage : "skipped",
          message: newlySelected ? "필수 개념 보완 호출 대기 중" : isSelected ? current.message : "이번 요청에서 제외됨",
        } satisfies LiveAgentState;
      })(),
    ]));
    nextCore = { ...nextCore, stage: "routing", message: event.message };
  }

  if (event.agentId && event.stage.startsWith("agent.")) {
    const current = nextAgents[event.agentId] ?? {
      selected: true,
      stage: "idle" as const,
      message: "실행 대기 중",
      evidenceCount: 0,
    };
    const stage: LiveAgentStage =
      event.stage === "agent.retrieving"
        ? "retrieving"
        : event.stage === "agent.retrieved"
          ? "retrieved"
          : event.stage === "agent.generating"
            ? "generating"
            : event.stage === "agent.mapping"
              ? "mapping"
            : event.stage === "agent.completed"
              ? event.backend === "ollama" ? "completed" : "fallback"
              : event.stage === "agent.mapped"
                ? "mapped"
              : "skipped";
    nextAgents = {
      ...nextAgents,
      [event.agentId]: {
        ...current,
        selected: stage === "skipped" ? false : true,
        stage,
        message: event.message,
        evidenceCount: event.evidenceCount ?? current.evidenceCount,
        backend: event.backend ?? current.backend,
        model: event.model ?? current.model,
      },
    };
  }

  if (event.stage.startsWith("central.")) {
    const stage: LiveCoreStage =
      event.stage === "central.retrieving" || event.stage === "central.retrieved"
        ? "retrieving"
        : event.stage === "central.generating"
          ? "generating"
          : event.stage === "central.integrating"
            ? "integrating"
            : "completed";
    nextCore = {
      ...nextCore,
      stage,
      message: event.message,
      evidenceCount: event.evidenceCount ?? nextCore.evidenceCount,
      backend: event.backend ?? nextCore.backend,
      model: event.model ?? nextCore.model,
    };
  } else if (event.stage === "judge.evaluating" || event.stage === "judge.completed") {
    nextCore = {
      ...nextCore,
      stage: event.stage === "judge.evaluating" ? "judging" : nextCore.stage,
      message: event.message,
    };
  } else if (
    event.stage === "request.received" ||
    event.stage === "request.sanitized" ||
    event.stage.startsWith("router.") ||
    event.stage === "evidence.plan.ready" ||
    event.stage === "agents.adapted"
  ) {
    nextCore = { ...nextCore, stage: "routing", message: event.message };
  } else if (event.stage === "request.completed") {
    nextCore = { ...nextCore, stage: "completed", message: event.message };
  }

  return {
    ...state,
    runId: event.runId,
    mode: event.mode,
    sequence: event.sequence,
    message: event.message,
    agents: nextAgents,
    core: nextCore,
    routerDecision: event.routerDecision ?? state.routerDecision,
    evidencePlan: event.evidencePlan ?? state.evidencePlan,
    activity: [...state.activity, { sequence: event.sequence, message: event.message }].slice(-5),
    execution: event.execution
      ? {
          status: event.execution.executionStatus,
          totalCount: event.execution.totalCount,
          terminalCount: event.execution.terminalCount,
          remainingCount: event.execution.remainingCount,
        }
      : state.execution,
  };
}

const exampleRequests = [
  "민원 상담용 생성형 AI 서비스를 도입하려고 합니다. 개인정보 보호, 클라우드 보안, 법적 책임과 예산 타당성을 종합 검토해 주세요.",
  "내부 연구자료 검색 AI를 구축하려고 합니다. 기술 구성과 보안 통제 방안을 중심으로 검토해 주세요.",
  "고객 응대 챗봇 외주 계약을 추진합니다. 계약상 책임과 예상 운영비를 검토해 주세요.",
  "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.",
];

const ACTIVE_RUN_STORAGE_KEY = "mnc-flow-active-run-v2";

function holdCompletedLiveState() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 320));
}

function agentLabel(agentId: string) {
  return agents.find((agent) => agent.id === agentId)?.shortName ?? agentId;
}

function RouterDecisionCard({ decision, compact = false }: { decision: RouterDecisionView; compact?: boolean }) {
  const primary = agents.find((agent) => agent.id === decision.primaryAgent);
  return (
    <section className={`routerDecisionCard ${compact ? "compact" : ""}`} aria-label="Boundary Router 결정">
      <header>
        <div><span>BOUNDARY ROUTER V2</span><strong>주관 Agent와 검토 경계를 결정했습니다</strong></div>
        <div className="routerBadges"><b>{decision.securityLevel}</b><b>{decision.purpose}</b></div>
      </header>
      <div className="routerFlow">
        <div className="routerPrimary" style={{ "--agent": primary?.color ?? "#5B8CFF" } as React.CSSProperties}>
          <small>PRIMARY</small><strong>{agentLabel(decision.primaryAgent)} Agent</strong><span>1차 처리 책임</span>
        </div>
        <i aria-hidden="true">→</i>
        <div className="routerSupports">
          <small>REVIEW / ADAPTIVE SUPPORT</small>
          <p>{decision.supportingAgents.length
            ? decision.supportingAgents.map((id) => <b key={id}>{agentLabel(id)}</b>)
            : <span>추가 호출 없음</span>}</p>
          {!!decision.adaptiveAdditions.length && <em>Coverage gap으로 {decision.adaptiveAdditions.map(agentLabel).join("·")} 추가</em>}
        </div>
      </div>
      {!compact && (
        <div className="routerStats">
          <div><span>예측 Coverage</span><strong>{Math.round(decision.predictedCoverage * 100)}%</strong></div>
          <div><span>Objective Cost</span><strong>{decision.objectiveCost.toFixed(3)}</strong></div>
          <div><span>Required Concepts</span><strong>{decision.requiredConcepts.length}</strong></div>
          <div><span>Required Review</span><strong>{decision.required.map(agentLabel).join(" · ")}</strong></div>
        </div>
      )}
      <p className="routerRationale">{decision.rationale.at(-1)}</p>
    </section>
  );
}

type FocusPhase = "routing" | "assigned" | "retrieving" | "integrating";

const focusSteps = ["요청 분석", "Agent 선택", "근거 수집", "중앙 통합", "결과"];

function getFocusPhase(state: LiveRunState): FocusPhase {
  if (
    state.core.stage === "retrieving" ||
    state.core.stage === "generating" ||
    state.core.stage === "integrating" ||
    state.core.stage === "judging" ||
    state.core.stage === "completed"
  ) return "integrating";

  const selected = Object.values(state.agents).filter((agent) => agent.selected === true);
  const hasAgentWork = selected.some((agent) =>
    agent.stage === "retrieving" ||
    agent.stage === "retrieved" ||
    agent.stage === "generating" ||
    agent.stage === "mapping" ||
    agent.stage === "completed" ||
    agent.stage === "mapped" ||
    agent.stage === "fallback",
  );
  if (hasAgentWork) return "retrieving";
  if (state.routerDecision || selected.length) return "assigned";
  return "routing";
}

function FocusStepper({ activeStep }: { activeStep: number }) {
  return (
    <ol className="focusStepper" aria-label="요청 처리 단계">
      {focusSteps.map((step, index) => (
        <li
          key={step}
          className={index < activeStep ? "complete" : index === activeStep ? "current" : "pending"}
          aria-current={index === activeStep ? "step" : undefined}
        >
          <span>{index < activeStep ? "\u2713" : index + 1}</span>
          <strong>{step}</strong>
        </li>
      ))}
    </ol>
  );
}

function agentLiveLabel(stage: LiveAgentStage) {
  const labels: Record<LiveAgentStage, string> = {
    idle: "대기 중",
    queued: "호출 대기 중",
    retrieving: "RAG 근거를 찾는 중",
    retrieved: "근거 수신 완료",
    generating: "근거 기반 응답 생성 중",
    mapping: "근거를 응답에 연결 중",
    completed: "응답 수신 완료",
    mapped: "근거 연결 완료",
    fallback: "안전 응답 수신 완료",
    skipped: "호출하지 않음",
    error: "처리 오류",
  };
  return labels[stage];
}

function executionStatusLabel(status: LiveRunState["execution"]["status"]) {
  const labels: Record<LiveRunState["execution"]["status"], string> = {
    queued: "실행 대기",
    running: "Agent 실행 중",
    integrating: "중앙 통합 중",
    completed: "처리 완료",
    partial_failed: "일부 실패 · 검토 중",
    failed: "처리 실패",
    cancelled: "요청 취소",
  };
  return labels[status];
}

function FocusedProcessingPanel({ state }: { state: LiveRunState }) {
  const phase = getFocusPhase(state);
  const activeStep = phase === "routing" ? 0 : phase === "assigned" ? 1 : phase === "retrieving" ? 2 : 3;
  const selectedAgents = agents.filter((agent) => state.agents[agent.id]?.selected === true);
  const primaryId = state.routerDecision?.primaryAgent;
  const primary = agents.find((agent) => agent.id === primaryId) ?? selectedAgents[0];
  const completedCount = selectedAgents.filter((agent) => {
    const stage = state.agents[agent.id]?.stage;
    return stage === "completed" || stage === "mapped" || stage === "fallback";
  }).length;
  const phaseCopy = phase === "routing"
    ? {
        eyebrow: "REQUEST RECEIVED",
        title: "요청의 업무영역과 정보 경계를 분석하고 있습니다",
        detail: "요청 전체의 의미와 필수 검토 규칙을 함께 확인해 가장 적합한 주관기관을 결정합니다.",
      }
    : phase === "assigned"
      ? {
          eyebrow: "AGENT SELECTED",
          title: `${primary?.shortName ?? "주관"} Agent를 주관기관으로 선택했습니다`,
          detail: "주관기관과 필수 검토 Agent에 필요한 최소 질문만 전달합니다.",
        }
      : phase === "retrieving"
        ? {
            eyebrow: "EDGE RAG IN PROGRESS",
            title: "선택된 Agent에게 근거와 답변을 받고 있습니다",
            detail: "기관별 원문은 Edge에 남겨 두고, 중앙에는 안전한 요약과 근거 ID만 전달합니다.",
          }
        : {
            eyebrow: "CENTRAL INTEGRATION",
            title: "중앙 모델이 근거와 응답을 통합하고 있습니다",
            detail: `${completedCount || selectedAgents.length}개 Agent 응답의 충돌·누락·출처 연결을 검증합니다.`,
          };

  return (
    <section className="focusShell processingFocus" aria-busy="true" aria-labelledby="processing-title">
      <FocusStepper activeStep={activeStep} />
      <div className={`processingHero phase-${phase}`}>
        <div className="processingSignal" aria-hidden="true"><i /><i /><b>{activeStep + 1}</b></div>
        <div>
          <span>{phaseCopy.eyebrow}</span>
          <h1 id="processing-title">{phaseCopy.title}</h1>
          <p>{phaseCopy.detail}</p>
        </div>
      </div>

      <p className="processingAnnouncement" aria-live="polite" aria-atomic="true">
        <span className="spinner dark" aria-hidden="true" />{state.message}
      </p>

      {state.execution.totalCount > 0 && (
        <div className="processingWorkload" role="status" aria-label="전체 작업 처리 현황">
          <span>{executionStatusLabel(state.execution.status)}</span>
          <div aria-hidden="true"><i style={{ width: `${Math.round(state.execution.terminalCount / state.execution.totalCount * 100)}%` }} /></div>
          <strong>{state.execution.remainingCount}개 작업 남음</strong>
          <small>{state.execution.terminalCount} / {state.execution.totalCount} 완료</small>
        </div>
      )}

      {phase !== "routing" && selectedAgents.length > 0 && (
        <section className="selectedAgentStage" aria-label="선택된 Agent 처리 현황">
          <header>
            <div><span>SELECTED AGENTS</span><strong>선택된 기관만 안전하게 실행합니다</strong></div>
            <b>{completedCount} / {selectedAgents.length} 응답 완료</b>
          </header>
          <div className="selectedAgentList">
            {selectedAgents.map((agent) => {
              const live = state.agents[agent.id];
              const isPrimary = agent.id === primaryId || (!primaryId && agent.id === selectedAgents[0]?.id);
              const role = isPrimary
                ? "주관기관"
                : state.routerDecision?.required.includes(agent.id)
                  ? "필수 검토"
                  : "지원기관";
              const finished = live.stage === "completed" || live.stage === "mapped" || live.stage === "fallback";
              const queueDetail = live.stage === "queued"
                ? live.queuePosition
                  ? `Queue ${live.queuePosition}번 · ${(Math.max(live.waitingMs ?? 0, 0) / 1000).toFixed(1)}초 대기`
                  : "실행 슬롯 확인 중"
                : null;
              return (
                <article key={agent.id} className={finished ? "finished" : "working"} style={{ "--agent": agent.color } as React.CSSProperties}>
                  <i aria-hidden="true">{agent.shortName.slice(0, 1)}</i>
                  <div><span>{role}</span><strong>{agent.shortName} Agent</strong><small>{agentLiveLabel(live.stage)}</small></div>
                  <b className={queueDetail ? "queueDetail" : undefined}>{queueDetail ?? (live.evidenceCount > 0 ? `근거 ${live.evidenceCount}건` : finished ? "수신 완료" : "처리 중")}</b>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {phase === "integrating" && (
        <section className="centralMergeCard" aria-label="중앙 통합 진행 상태">
          <div className="mergeMark" aria-hidden="true"><i /><i /><i /><b>CORE</b></div>
          <div><span>AXNETCC CENTRAL MODEL</span><strong>Agent 근거를 하나의 답변으로 조정 중</strong><small>{state.core.model ?? "안전 요약·근거 ID 기반 통합"}</small></div>
          <p><i />중앙 통합 중</p>
        </section>
      )}

      <div className="privacyAssurance"><span aria-hidden="true">◆</span><p><strong>원문은 각 기관에 유지됩니다.</strong> 화면에는 민감 원문을 제외한 처리 상태만 표시합니다.</p></div>
    </section>
  );
}

function AppHeader({ health }: { health: LlmHealth | null }) {
  return (
    <header className="topbar focusTopbar">
      <Link className="brand" href="/" aria-label="MNC Flow 요청 화면">
        <span className="brandMark" aria-hidden="true">M</span>
        <div><strong>MNC FLOW</strong><small>Distributed AI Governance</small></div>
      </Link>
      <nav className="navLinks" aria-label="주요 페이지">
        <Link className="aboutLink" href="/about">서비스 소개</Link>
        <Link className="aboutLink" href="/evaluation">평가 결과</Link>
      </nav>
      <div className="networkState" role="status">
        <span aria-hidden="true" /> {!health
          ? "Agent 연결 확인 중"
          : health.status === "connected"
            ? `${health.connected}/${health.total} Agent 준비됨`
            : `${health.connected}/${health.total} Agent 연결`}
      </div>
    </header>
  );
}

function CitationChips({ citations }: { citations: string[] }) {
  if (!citations.length) return null;
  return (
    <span className="reportCitations" aria-label="연결된 RAG 근거">
      {citations.map((citation) => (
        <b key={citation} data-evidence-id={citation}>[{citation}]</b>
      ))}
    </span>
  );
}

function IntegratedReportDocument({
  report,
  agents,
}: {
  report: IntegratedEvidenceReport;
  agents: AgentResult[];
}) {
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <section className="reportDocument" data-testid="integrated-report" aria-labelledby="integrated-report-title">
      <header>
        <div><span>INTEGRATED EVIDENCE REPORT · v{report.version}</span><h2 id="integrated-report-title">{report.title}</h2></div>
        <p>주관·협력 Agent의 RAG 근거와 검토보고서를 중앙에서 통합했습니다.</p>
      </header>
      <article className="reportExecutiveSummary">
        <span>EXECUTIVE SUMMARY</span>
        <p>{report.executiveSummary}</p>
        <div>
          <b>주관 {agentById.get(report.primaryAgentId)?.shortName ?? report.primaryAgentId}</b>
          <small>참여 Agent {report.participatingAgentIds.length}개 · 참고 근거 {report.references.length}건</small>
        </div>
      </article>
      <div className="reportSections">
        {report.sections.map((section, index) => (
          <article key={`${section.title}-${index}`}>
            <span>{index === 0 ? "01 · 종합 결론" : `${String(index + 1).padStart(2, "0")} · 전문 검토`}</span>
            <h3>{section.title}</h3>
            <p>{section.content}</p>
            <footer>
              <small>{section.sourceAgentIds.map((id) => agentById.get(id)?.shortName ?? id).join(" · ")}</small>
              <CitationChips citations={section.citations} />
            </footer>
          </article>
        ))}
      </div>
      <div className="reportRecommendations">
        <h3>실행 권고안</h3>
        {report.recommendations.map((recommendation, index) => (
          <article key={`${recommendation.content}-${index}`}>
            <b className={recommendation.priority}>{recommendation.priority === "high" ? "우선" : recommendation.priority === "medium" ? "중기" : "후속"}</b>
            <p>{recommendation.content}</p>
            <CitationChips citations={recommendation.citations} />
          </article>
        ))}
      </div>
      <footer className="reportLimitations">
        <strong>검토 범위와 한계</strong>
        <ul>{report.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </footer>
    </section>
  );
}

function AgentReportDocument({ agent }: { agent: AgentResult }) {
  const report = agent.report;
  if (!report) {
    return (
      <article className="agentAnswer" data-testid="agent-report">
        <span>AGENT RESPONSE</span><h3>{agent.shortName} Agent의 검토 의견</h3><p>{agent.summary}</p>
      </article>
    );
  }
  return (
    <article className="agentReportDocument" data-testid="agent-report">
      <header><span>AGENT EVIDENCE REPORT · v{report.version}</span><h3>{report.title}</h3><p>{report.executiveSummary}</p></header>
      <div className="agentReportFindings">
        {report.findings.map((finding, index) => (
          <section key={`${finding.title}-${index}`}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            <div><h4>{finding.title}</h4><p>{finding.content}</p><CitationChips citations={finding.citations} /></div>
          </section>
        ))}
      </div>
      <div className="agentReportRecommendations">
        <strong>실행 권고</strong>
        {report.recommendations.map((recommendation, index) => <p key={`${recommendation.content}-${index}`}>{recommendation.content}<CitationChips citations={recommendation.citations} /></p>)}
      </div>
      <div className="responsibility"><strong>검토 주체</strong><span>{agent.responsibility}</span></div>
      <small className="agentReportLimitation">{report.limitations.join(" · ")}</small>
    </article>
  );
}

function AgentProcessingPath({ result, agents: selectedAgents }: { result: RunResult; agents: AgentResult[] }) {
  const primaryId = result.report?.primaryAgentId ?? result.routerDecision?.primaryAgent ?? selectedAgents[0]?.id;
  const integrationLabel = result.integration?.label ?? "Core Orchestrator";
  const integrationModel = result.integration?.backend === "ollama"
    ? result.integration.model ?? "Local LLM"
    : "안전 응답 모드";

  return (
    <section className="agentProcessingPath" data-testid="agent-processing-path" aria-labelledby="agent-processing-path-title">
      <header>
        <div><span>RESPONSE GENERATION PATH</span><h2 id="agent-processing-path-title">Agent를 통해 응답을 생성한 과정</h2></div>
        <p>중앙 라우터가 담당 영역을 정하고, 각 Agent의 RAG 검토보고서를 중앙에서 통합했습니다.</p>
      </header>

      {result.routerDecision && <RouterDecisionCard decision={result.routerDecision} compact />}

      <div className="agentPathFlow">
        <article className="agentPathNode routerNode">
          <span>01 · ROUTING</span>
          <strong>Boundary Router</strong>
          <p>요청의 담당 영역을 분석해 주관·협력 Agent를 선택</p>
        </article>
        <i aria-hidden="true">→</i>
        <div className="agentPathGroup" aria-label="응답 생성에 참여한 Agent">
          {selectedAgents.map((agent) => {
            const role = agent.id === primaryId
              ? "주관 Agent"
              : agent.executionRole === "required-reviewer"
                ? "필수 검토 Agent"
                : "협력 Agent";
            return (
              <article key={agent.id} className={agent.id === primaryId ? "primary" : "supporting"} style={{ "--agent": agent.color } as React.CSSProperties}>
                <i aria-hidden="true">{agent.shortName.slice(0, 1)}</i>
                <div><span>{role}</span><strong>{agent.shortName} Agent</strong><small>RAG 근거 {agent.evidence.length}건 검토 · 보고서 생성</small></div>
              </article>
            );
          })}
        </div>
        <i aria-hidden="true">→</i>
        <article className="agentPathNode integrationNode">
          <span>03 · INTEGRATION</span>
          <strong>{integrationLabel}</strong>
          <p>{integrationModel}이 Agent 보고서와 근거를 중앙 통합</p>
        </article>
      </div>
    </section>
  );
}

function FocusedResultPanel({
  result,
  activeAgent,
  onAgentChange,
  onNewRequest,
}: {
  result: RunResult;
  activeAgent: string;
  onAgentChange: (id: string) => void;
  onNewRequest: () => void;
}) {
  const selectedAgents = result.agents.filter((agent) => agent.selected);
  const selected = selectedAgents.find((agent) => agent.id === activeAgent) ?? selectedAgents[0] ?? result.agents[0];
  const primaryId = result.report?.primaryAgentId ?? result.routerDecision?.primaryAgent;

  return (
    <section className="focusShell finalFocus" aria-labelledby="final-result-title">
      <FocusStepper activeStep={4} />
      <header className="finalHero">
        <div className="finalCheck" aria-hidden="true">{"\u2713"}</div>
        <div>
          <span>REQUEST COMPLETED · {result.runId}</span>
          <h1 id="final-result-title">{result.title}</h1>
          <p>주관·협력 Agent의 RAG 검토와 중앙 통합이 완료되었습니다.</p>
        </div>
        <b className={result.status}>{result.status === "ready" ? "응답 완료" : "검토 필요"}</b>
      </header>

      <AgentProcessingPath result={result} agents={selectedAgents} />

      {result.report
        ? <IntegratedReportDocument report={result.report} agents={selectedAgents} />
        : <section className="reportDocument legacyIntegratedReport" data-testid="integrated-report"><header><div><span>INTEGRATED REVIEW</span><h2>중앙 통합 검토 의견</h2></div></header><article className="reportExecutiveSummary"><p>{result.conclusion}</p></article></section>}

      <section className="resultEvidence" data-testid="result-agent-evidence" aria-labelledby="evidence-title">
        <header>
          <div><span>AGENT REVIEW REPORTS</span><h2 id="evidence-title">Agent별 검토보고서와 RAG 근거</h2></div>
          <p>Agent를 선택하면 주관·협력 기관의 검토보고서와 연결된 근거 문서를 확인할 수 있습니다.</p>
        </header>
        <div className="resultAgentTabs" role="tablist" aria-label="Agent별 근거">
          {selectedAgents.map((agent) => {
            const isPrimary = agent.id === primaryId;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={selected.id === agent.id}
                className={selected.id === agent.id ? "active" : ""}
                key={agent.id}
                onClick={() => onAgentChange(agent.id)}
              >
                <i style={{ "--agent": agent.color } as React.CSSProperties}>{agent.shortName.slice(0, 1)}</i>
                <span><strong>{agent.shortName} Agent</strong><small>{isPrimary ? "주관기관" : agent.executionRole === "required-reviewer" ? "필수 검토" : "지원기관"}</small></span>
                <b>{agent.evidence.length}</b>
              </button>
            );
          })}
        </div>
        <div className="resultEvidenceBody" role="tabpanel" aria-label={`${selected.shortName} Agent 응답과 근거`}>
          <AgentReportDocument agent={selected} />
          <div className="evidenceList">
            {selected.evidence.length ? selected.evidence.map((source) => {
              const classification = source.classification ?? "public";
              const referenceOnly = source.disclosure === "reference-only" || classification === "confidential";
              return (
                <article key={source.id}>
                  <div><b>{source.id}</b><span>{classification}</span></div>
                  {source.sourceUrl && !referenceOnly
                    ? <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.title}</a>
                    : <strong>{source.title}</strong>}
                  <p>{referenceOnly ? "보호된 원문은 Edge에 보존되며 중앙에는 근거 ID만 전달되었습니다." : source.excerpt}</p>
                </article>
              );
            }) : <p className="noEvidence">표시할 수 있는 근거가 없습니다. Agent 보고서의 검토 범위와 한계를 확인하세요.</p>}
          </div>
        </div>
      </section>

      <div className="resultActions"><button type="button" onClick={onNewRequest}>새 요청 시작</button><Link href={`/evaluation?run=${encodeURIComponent(result.runId)}`}>성능 평가 결과 보기</Link></div>
    </section>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RunResult["mode"]>("proposed");
  const [result, setResult] = useState<RunResult | null>(null);
  const [llmHealth, setLlmHealth] = useState<LlmHealth | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [commercialJudgeEnabled, setCommercialJudgeEnabled] = useState(false);
  const [activeAgent, setActiveAgent] = useState("security");
  const [liveRun, dispatchLiveRun] = useReducer(liveRunReducer, createLiveRunState("proposed"));
  const streamControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const boundaryMode = running ? liveRun.mode : mode;
  const dataBoundaryNotice =
    boundaryMode === "managed"
      ? "Agent 요약·근거 ID·계측값만 중앙 Supervisor로 전달됩니다."
      : boundaryMode === "centralized" || boundaryMode === "remoterag"
        ? "Edge에서 허용된 요약과 근거 ID만 중앙 통합 단계로 전달됩니다."
        : "원문은 각 Edge에 유지되고 요약·근거 ID·계측값만 Core로 전달됩니다.";

  useEffect(() => {
    let active = true;
    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((health: LlmHealth) => {
        if (active) setLlmHealth(health);
      })
      .catch(() => {
        if (active) setLlmHealth({ status: "disconnected", connected: 0, total: 8, model: "" });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => streamControllerRef.current?.abort(), []);

  const fetchRunSnapshot = useCallback(async (requestId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/runs/${encodeURIComponent(requestId)}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      const code = payload.error ?? `HTTP_${response.status}`;
      throw new RunApiError(response.status, code, code === "RUN_NOT_FOUND"
        ? "이전 실행 정보가 만료되었습니다. 새 요청으로 다시 시작해 주세요."
        : "실행 상태를 조회하지 못했습니다.");
    }
    return response.json() as Promise<RunApiSnapshot>;
  }, []);

  const pollingDelay = useCallback((signal: AbortSignal, ms = 650) => {
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = () => {
        window.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        reject(signal.reason ?? new DOMException("Run observation cancelled", "AbortError"));
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }, []);

  const observeRun = useCallback(async (
    requestId: string,
    targetMode: RunResult["mode"],
    controller: AbortController,
  ): Promise<RunResult> => {
    activeRequestIdRef.current = requestId;
    window.localStorage.setItem(
      ACTIVE_RUN_STORAGE_KEY,
      JSON.stringify({ requestId, mode: targetMode }),
    );
    const eventSource = new EventSource(`/api/runs/${encodeURIComponent(requestId)}/events`);
    eventSource.addEventListener("progress", (message) => {
      try {
        dispatchLiveRun({ type: "event", event: JSON.parse(message.data) as ProgressEvent });
      } catch {
        // Polling remains authoritative if an individual event is malformed.
      }
    });
    eventSource.onerror = () => {
      // EventSource reconnects with Last-Event-ID; polling covers SSE/proxy failures.
    };
    const close = () => eventSource.close();
    controller.signal.addEventListener("abort", close, { once: true });
    let releaseActiveRun = false;
    try {
      while (!controller.signal.aborted) {
        const snapshot = await fetchRunSnapshot(requestId, controller.signal);
        dispatchLiveRun({ type: "snapshot", snapshot });
        if (isRunStartStalled(snapshot)) {
          releaseActiveRun = true;
          window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
          void fetch(`/api/runs/${encodeURIComponent(requestId)}`, {
            method: "DELETE",
            keepalive: true,
          }).catch(() => undefined);
          throw new RunApiError(
            409,
            "RUN_START_STALLED",
            "실행 엔진이 시작되지 않아 중단했습니다. 잠시 후 새 요청으로 다시 시도해 주세요.",
          );
        }
        if (snapshot.status === "completed" || snapshot.status === "partial_failed") {
          if (!snapshot.result) throw new Error("완료된 실행에 결과가 없습니다.");
          releaseActiveRun = true;
          window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
          return snapshot.result;
        }
        if (snapshot.status === "failed" || snapshot.status === "cancelled") {
          releaseActiveRun = true;
          window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
          throw new Error(snapshot.status === "cancelled" ? "요청 처리가 취소되었습니다." : "요청 처리에 실패했습니다.");
        }
        await pollingDelay(controller.signal);
      }
      throw controller.signal.reason ?? new DOMException("Run observation cancelled", "AbortError");
    } catch (error) {
      if (error instanceof RunApiError && error.code === "RUN_NOT_FOUND") {
        releaseActiveRun = true;
        window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      }
      throw error;
    } finally {
      eventSource.close();
      controller.signal.removeEventListener("abort", close);
      if (releaseActiveRun && activeRequestIdRef.current === requestId) {
        activeRequestIdRef.current = null;
      }
    }
  }, [fetchRunSnapshot, pollingDelay]);

  useEffect(() => {
    const stored = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    if (!stored) return;

    let parsed: { requestId?: unknown; mode?: unknown };
    try {
      parsed = JSON.parse(stored) as typeof parsed;
    } catch {
      window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      return;
    }

    const resumableModes: RunResult["mode"][] = [
      "proposed", "parallel", "centralized", "managed", "masrouter", "remoterag",
    ];
    if (typeof parsed.requestId !== "string" || !resumableModes.includes(parsed.mode as RunResult["mode"])) {
      window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      return;
    }

    const requestId = parsed.requestId;
    const resumedMode = parsed.mode as RunResult["mode"];
    const controller = new AbortController();
    let mounted = true;
    const resumeTimer = window.setTimeout(() => {
      if (!mounted) return;
      streamControllerRef.current = controller;
      setMode(resumedMode);
      setRunning(true);
      dispatchLiveRun({ type: "reset", mode: resumedMode, label: "기존 요청에 다시 연결하는 중" });
      void observeRun(requestId, resumedMode, controller)
        .then((next) => {
          if (!mounted) return;
          setResult(next);
          const first = next.agents.find((agent) => agent.selected);
          if (first) setActiveAgent(first.id);
        })
        .catch((error) => {
          if (!mounted || controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : "기존 요청에 다시 연결하지 못했습니다.";
          dispatchLiveRun({ type: "error", message });
          setRunError(message);
        })
        .finally(() => {
          if (mounted) setRunning(false);
        });
    }, 0);

    return () => {
      mounted = false;
      window.clearTimeout(resumeTimer);
      controller.abort("page unmounted");
    };
  }, [observeRun]);

  async function executeMode(targetMode: RunResult["mode"], label?: string): Promise<RunResult> {
    streamControllerRef.current?.abort();
    const controller = new AbortController();
    streamControllerRef.current = controller;
    dispatchLiveRun({ type: "reset", mode: targetMode, label });

    let handshakeTimedOut = false;
    const handshakeTimeout = window.setTimeout(() => {
      handshakeTimedOut = true;
      controller.abort(new DOMException("Run start handshake timed out", "TimeoutError"));
    }, 10_000);

    try {
      let response: Response;
      try {
        response = await fetch("/api/runs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "idempotency-key": `browser-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({ query, mode: targetMode, commercialJudge: commercialJudgeEnabled }),
          signal: controller.signal,
        });
      } catch (error) {
        if (handshakeTimedOut) {
          throw new Error("실행 서버가 10초 안에 요청을 접수하지 못했습니다. 서버 상태를 확인해 주세요.");
        }
        throw error;
      } finally {
        window.clearTimeout(handshakeTimeout);
      }
      const payload = await response.json().catch(() => ({})) as { requestId?: string; error?: string };
      if (!response.ok || !payload.requestId) {
        throw new Error(payload.error ?? "비동기 실행을 시작하지 못했습니다.");
      }
      return await observeRun(payload.requestId, targetMode, controller);
    } finally {
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
    }
  }

  async function run() {
    setRunning(true);
    setRunError("");
    try {
      const next = await executeMode(mode, modeLabels[mode]);
      setResult(next);
      const first = next.agents.find((agent) => agent.selected);
      if (first) setActiveAgent(first.id);
      await holdCompletedLiveState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "실행에 실패했습니다.";
      dispatchLiveRun({ type: "error", message });
      setRunError(`${message} Local LLM 연결 상태를 확인한 뒤 다시 시도해 주세요.`);
    } finally {
      setRunning(false);
    }
  }

  function startNewRequest() {
    const requestId = activeRequestIdRef.current;
    streamControllerRef.current?.abort();
    window.localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
    if (requestId) {
      void fetch(`/api/runs/${encodeURIComponent(requestId)}`, { method: "DELETE", keepalive: true });
    }
    setResult(null);
    setRunError("");
    setQuery("");
    dispatchLiveRun({ type: "reset", mode });
  }

  const requestView = (
    <section className="focusShell requestFocus" aria-labelledby="request-title">
      <div className="requestIntro">
        <h1 id="request-title">AXNetCC</h1>
        <p>공공기관과 기업 AX를 위한<br /><strong>분산형 Multi-Agent RAG</strong> 및<br /><strong lang="en">Security-Aware Evidence Acquisition</strong><br />연구 구현</p>
      </div>
      <form className="requestComposer" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <label htmlFor="work-request"><span>업무 요청</span><small>검토할 배경과 원하는 결과를 함께 적어 주세요.</small></label>
        <textarea
          id="work-request"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="예: 공공 AI 시범사업의 성능 기준과 운영 전환 조건을 근거와 함께 정리해 주세요."
          required
        />
        <div className="requestExamples" aria-label="요청 예시">
          {exampleRequests.map((example, index) => (
            <button type="button" key={example} onClick={() => setQuery(example)}>예시 {index + 1}</button>
          ))}
        </div>
        <details className="requestOptions">
          <summary><span><strong>실행 옵션</strong><small>기본값은 동적 Agent 선택 방식입니다.</small></span><b>설정</b></summary>
          <div>
            <label>실행 방식</label>
            <div className="requestModeGrid" role="group" aria-label="실행 방식">
              {[
                ["proposed", "제안 방식", "의미 기반 동적 선택"],
                ["managed", "Managed", "중앙 Supervisor 통합"],
                ["parallel", "병렬 방식", "전체 Agent 호출"],
                ["centralized", "중앙집중형", "중앙에서 전체 처리"],
              ].map(([id, label, detail]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={mode === id}
                  className={mode === id ? "active" : ""}
                  onClick={() => setMode(id as RunResult["mode"])}
                >
                  <strong>{label}</strong><small>{detail}</small>
                </button>
              ))}
            </div>
            <label className="judgeToggle compactToggle">
              <input
                type="checkbox"
                checked={commercialJudgeEnabled}
                onChange={(event) => setCommercialJudgeEnabled(event.target.checked)}
              />
              <span><strong>상용 LLM 전문가 평가</strong><small>외부 평가 API로 안전한 평가 payload가 전달됩니다.</small></span>
            </label>
          </div>
        </details>
        <button className="primaryRequestButton" type="submit" disabled={!query.trim()}>
          요청 처리 시작 <span aria-hidden="true">→</span>
        </button>
        <p className="requestPrivacy"><span aria-hidden="true">◆</span>{dataBoundaryNotice}</p>
      </form>
    </section>
  );

  const errorView = (
    <section className="focusShell errorFocus" role="alert" aria-labelledby="error-title">
      <FocusStepper activeStep={0} />
      <div className="errorMark" aria-hidden="true">!</div>
      <span>PROCESS INTERRUPTED</span>
      <h1 id="error-title">요청을 처리하지 못했습니다</h1>
      <p>{runError}</p>
      <div>
        <button type="button" onClick={() => void run()}>다시 시도</button>
        <button type="button" className="secondary" onClick={startNewRequest}>요청 수정</button>
      </div>
    </section>
  );

  return (
    <main className="focusApp">
      <div className="focusExperience">
        <AppHeader health={llmHealth} />
        <div className="focusViewport">
          {running
            ? <FocusedProcessingPanel state={liveRun} />
            : runError
              ? errorView
              : result
                ? <FocusedResultPanel result={result} activeAgent={activeAgent} onAgentChange={setActiveAgent} onNewRequest={startNewRequest} />
                : requestView}
        </div>
        <footer className="focusFooter"><span>MNC Lab. · Korea University</span><span>KOREN 기반 분산 AI Agent 협력 거버넌스 플랫폼</span></footer>
      </div>
    </main>
  );
}
