"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isRunStartStalled } from "../lib/run-observation";
import WorkspaceNav from "./components/WorkspaceNav";
import FeedbackForm from "./components/FeedbackForm";
import AgentTopology from "./components/AgentTopology";
import RoutingExplanation from "./components/RoutingExplanation";

export type RouterDecisionView = {
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
  supportSelection?: Array<{ agentId: string; reason: "required-review" | "coverage-gap"; missingConceptIds: string[] }>;
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
      profileMatches?: Array<{ requestToken: string; profileToken: string; affinity: number; contribution: number }>;
      weightedComponents?: Record<string, number>;
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
    section?: string;
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
  resilience?: { recoveredAgents: number; degraded: boolean };
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
            selected: task.status === "skipped" ? false : task.status === "queued" ? task.required || current.selected === true : true,
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
  "공공부문 AI 도입 가이드(2026.5.)에서 RAG 도구의 파싱, 청킹, 임베딩, 검색 API 구성은 어떻게 설명하나요? 제공된 공개 근거에 있는 내용만 요약해 주세요.",
  "내부 연구자료 검색 AI를 구축하려고 합니다. 기술 구성과 보안 통제 방안을 중심으로 검토해 주세요.",
  "고객 응대 챗봇 외주 계약을 추진합니다. 계약상 책임과 예상 운영비를 검토해 주세요.",
  "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.",
];

const ACTIVE_RUN_STORAGE_KEY = "mnc-flow-active-run-v2";

function holdCompletedLiveState() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 320));
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
    fallback: "규칙 기반 대체 응답 수신 완료",
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

function FocusedProcessingPanel({ state, onCancel, cancelling, cancelError }: { state: LiveRunState; onCancel: () => void; cancelling: boolean; cancelError: string }) {
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
        title: "요청의 업무 영역과 검토 규칙을 확인 중입니다",
        detail: "요청 단어와 Agent 프로필의 일치 점수, 필수 검토 규칙으로 주관 Agent를 선택합니다.",
      }
    : phase === "assigned"
      ? {
          eyebrow: "AGENT SELECTED",
          title: `${primary?.shortName ?? "주관"} Agent를 주관 역할로 선택했습니다`,
          detail: "선택된 Agent에 검토 요청을 전달합니다.",
        }
      : phase === "retrieving"
        ? {
            eyebrow: "EDGE RAG IN PROGRESS",
            title: "Agent가 근거를 검색하고 답변을 생성 중입니다",
            detail: "역할별 문서에서 근거를 검색하고, 허용된 근거 발췌와 출처 정보를 중앙으로 전달합니다.",
          }
        : {
            eyebrow: "CENTRAL INTEGRATION",
            title: "중앙 모델이 Agent 답변을 통합 중입니다",
            detail: `${completedCount || selectedAgents.length}개 Agent의 답변과 근거를 통합합니다.`,
          };

  return (
    <section className="focusShell processingFocus" aria-busy="true" aria-labelledby="processing-title">
      <AgentTopology agents={agents} state={state} stageLabel={(stage) => agentLiveLabel(stage as LiveAgentStage)} />
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
      <div className="processingControls">
        <p>처리 단계를 실시간으로 표시합니다. 응답 시간은 질문과 대기열에 따라 달라집니다.</p>
        <button type="button" onClick={onCancel} disabled={cancelling}>{cancelling ? "취소 확인 중…" : "요청 취소"}</button>
      </div>
      {cancelError && <p role="alert" className="requestPrivacy">{cancelError}</p>}

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
            <div><span>SELECTED AGENTS</span><strong>선택된 Agent의 처리 상태</strong></div>
            <b>{completedCount} / {selectedAgents.length} 응답 완료</b>
          </header>
          <div className="selectedAgentList">
            {selectedAgents.map((agent) => {
              const live = state.agents[agent.id];
              const isPrimary = agent.id === primaryId || (!primaryId && agent.id === selectedAgents[0]?.id);
              const role = isPrimary
                ? "주관 역할"
                : state.routerDecision?.required.includes(agent.id)
                  ? "필수 검토"
                  : "지원 역할";
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
          <div><span>AXNETCC CENTRAL MODEL</span><strong>Agent 답변과 근거를 통합 중</strong><small>{state.core.model ?? "근거 발췌·근거 ID 기반 통합"}</small></div>
          <p><i />중앙 통합 중</p>
        </section>
      )}

      <div className="privacyAssurance"><span aria-hidden="true">◆</span><p><strong>지원하는 공개 문서 범위에서 처리합니다.</strong> 화면에는 민감 원문을 제외한 처리 상태만 표시합니다.</p></div>
    </section>
  );
}

function AppHeader({ health }: { health: LlmHealth | null }) {
  return (
    <header className="topbar focusTopbar">
      <Link className="brand" href="/" aria-label="MNC Flow 요청 화면">
        <span className="brandMark" aria-hidden="true">MNC</span>
        <div><strong>MNC LAB</strong><small>Agent 라우팅 · 근거 검색</small></div>
      </Link>
      <WorkspaceNav active="service" />
      <div className="networkState" role="status">
        <span aria-hidden="true" /> {!health
          ? "Agent 구성 확인 중"
          : `${health.total}개 Agent 구성 · 응답 시 상태 확인`}
      </div>
    </header>
  );
}

function CitationChips({ citations }: { citations: string[] }) {
  if (!citations.length) return null;
  return (
    <span className="reportCitations" aria-label="연결된 RAG 근거">
      {citations.map((citation) => (
        <a key={citation} data-evidence-id={citation} href={"#" + encodeURIComponent("evidence-" + citation)}>[{citation}]</a>
      ))}
    </span>
  );
}

/** Presentation only: retain exact provider-validated text; do not imply semantic verification. */
function GroundedAnswerContent({ text, evidenceIds }: { text: string; evidenceIds: string[] }) {
  const generated = text.startsWith("공개 근거를 바탕으로 생성한 답변 (source-grounded generation");
  const linkedText = (line: string) => line.split(/(\[[^\]\n]+\])/g).map((part, index) => {
    const id = part.slice(1, -1);
    return part.startsWith("[") && evidenceIds.includes(id)
      ? <a key={index} className="groundedCitation" href={"#" + encodeURIComponent("evidence-" + id)}>{part}</a>
      : part;
  });
  return <div className="groundedAnswer" data-testid="grounded-answer">
    <p className="groundedMethod">{generated ? "공개 근거를 바탕으로 모델이 작성한 답변입니다. 생성된 주장에 대한 의미 검증은 완료되지 않았습니다." : "모델이 공개 문서의 근거를 선택하고 원문 발췌를 표시합니다."} 인용 연결은 답변의 적합성이나 실제 서비스의 요건 충족을 보증하지 않습니다.</p>
    {text.split(/\n+/).filter(Boolean).map((line, index) => {
      if (line.startsWith("요청 Q")) return <h3 key={index}>{line}</h3>;
      if (line.startsWith("“")) return <blockquote key={index}>{linkedText(line)}</blockquote>;
      if (line.startsWith("확인 불가 / 필요한 정보:")) return <aside key={index} className="groundedUnknown"><strong>확인 불가 · 필요한 정보</strong><p>{line.slice("확인 불가 / 필요한 정보:".length)}</p></aside>;
      if (line.startsWith("적용 범위:")) return <aside key={index} className="groundedScope"><strong>적용 범위</strong><p>{line.slice("적용 범위:".length)}</p></aside>;
      if (line.startsWith("판단 범위:")) return <aside key={index} className="groundedScope"><strong>판단 범위</strong><p>{line.slice("판단 범위:".length)}</p></aside>;
      return <p key={index} className={line.startsWith("- 문서 발췌") ? "groundedSource" : undefined}>{linkedText(line)}</p>;
    })}
  </div>;
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
  if (agent.summary.includes("model-guided extractive") || agent.summary.startsWith("공개 근거를 바탕으로 생성한 답변 (source-grounded generation")) return <article className="agentReportDocument" data-testid="agent-report"><h3>{agent.shortName} Agent · 공개 근거 기반 답변</h3><GroundedAnswerContent text={agent.summary} evidenceIds={agent.evidence.map(source => source.id)} /></article>;
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
  const evidence = Array.from(new Map(selectedAgents.flatMap(agent => agent.evidence.map(source => [source.id, { ...source, agentName: agent.shortName }] as const))).values());

  return (
    <section className="focusShell finalFocus" aria-labelledby="final-result-title">
      <header className="finalHero">
        <div className="finalCheck" aria-hidden="true">{"\u2713"}</div>
        <div>
          <span>REQUEST COMPLETED · {result.runId}</span>
          <h1 id="final-result-title">{result.title}</h1>
          <p>통합 답변, 근거 자료, Agent 선택 이유를 표시합니다.</p>
        </div>
        <b className={result.status}>{result.status === "ready" ? "응답 완료" : "검토 필요"}</b>
      </header>

      {result.resilience && (result.resilience.recoveredAgents > 0 || result.resilience.degraded) && (
        <p className="requestPrivacy" role="status" data-testid="service-resilience-status">
          {result.resilience.recoveredAgents > 0 ? `백업 Agent로 ${result.resilience.recoveredAgents}개 분야의 응답을 복구했습니다. ` : ""}
          {result.resilience.degraded ? "일부 결과는 대체 처리되었거나 추가 검토가 필요합니다. 근거와 한계를 확인하세요." : ""}
        </p>
      )}
      {result.conclusion.includes("model-guided extractive") || result.conclusion.startsWith("공개 근거를 바탕으로 생성한 답변 (source-grounded generation")
        ? <section className="reportDocument" data-testid="integrated-report"><header><div><span>PUBLIC DOCUMENT EVIDENCE</span><h2>질문별 근거와 확인이 필요한 부분</h2></div></header><GroundedAnswerContent text={result.conclusion} evidenceIds={evidence.map(source => source.id)} /></section>
        : result.report
        ? <IntegratedReportDocument report={result.report} agents={selectedAgents} />
        : <section className="reportDocument legacyIntegratedReport" data-testid="integrated-report"><header><div><span>INTEGRATED REVIEW</span><h2>중앙 통합 검토 의견</h2></div></header><article className="reportExecutiveSummary"><p>{result.conclusion}</p></article></section>}

      <section className="resultEvidence" data-testid="result-agent-evidence" aria-labelledby="evidence-title">
        <header><div><span>02 · REPORT EVIDENCE</span><h2 id="evidence-title">보고서의 근거 자료</h2></div><p>인용 번호를 누르면 해당 자료로 이동합니다. 아래에서 출처와 Agent별 검토 의견을 확인할 수 있습니다.</p></header>
        <div className="reportEvidenceSources">
          {evidence.length ? evidence.map((source) => {
            const classification = source.classification ?? "public";
            const referenceOnly = source.disclosure === "reference-only" || classification === "confidential";
            return <article key={source.id} id={"evidence-" + source.id} tabIndex={-1}>
              <div><b>[{source.id}]</b><span>{source.agentName} Agent · {classification}</span></div>
              {source.sourceUrl && !referenceOnly ? <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.title} ↗</a> : <h3>{source.title}</h3>}
              <p>{referenceOnly ? "보호된 원문은 Edge에 보존되며 중앙에는 근거 ID만 전달되었습니다." : source.excerpt}</p>
              <small>{source.section ? `문서 위치 ${source.section} · ` : ""}자료 기준일 {source.effectiveDate || "미상 · 원문 확인 필요"}</small>
            </article>;
          }) : <p className="noEvidence">표시할 수 있는 근거가 없습니다. 보고서의 검토 범위와 한계를 확인하세요.</p>}
        </div>
        {selected && <details className="agentReviewDetails"><summary>Agent별 세부 검토 의견 보기</summary>
          <div className="resultAgentTabs" role="tablist" aria-label="Agent별 검토 의견">
            {selectedAgents.map((agent) => <button type="button" role="tab" key={agent.id}
              id={"review-tab-" + agent.id} aria-controls="agent-review-panel" aria-selected={selected.id === agent.id}
              tabIndex={selected.id === agent.id ? 0 : -1} className={selected.id === agent.id ? "active" : ""}
              onClick={() => onAgentChange(agent.id)} onKeyDown={(event) => {
                const index = selectedAgents.findIndex(item => item.id === agent.id);
                const next = event.key === "ArrowRight" ? (index + 1) % selectedAgents.length : event.key === "ArrowLeft" ? (index - 1 + selectedAgents.length) % selectedAgents.length : event.key === "Home" ? 0 : event.key === "End" ? selectedAgents.length - 1 : null;
                if (next === null) return;
                event.preventDefault(); onAgentChange(selectedAgents[next].id); document.getElementById("review-tab-" + selectedAgents[next].id)?.focus();
              }}>
              <i style={{ "--agent": agent.color } as React.CSSProperties}>{agent.shortName.slice(0, 1)}</i><span><strong>{agent.shortName} Agent</strong><small>{agent.id === primaryId ? "주관 역할" : agent.executionRole === "required-reviewer" ? "필수 검토" : "지원 역할"}</small></span>
            </button>)}
          </div>
          <div id="agent-review-panel" role="tabpanel" aria-labelledby={"review-tab-" + selected.id}><AgentReportDocument agent={selected} /></div>
        </details>}
      </section>

      <RoutingExplanation decision={result.routerDecision} agents={selectedAgents} mode={result.mode} />

      <FeedbackForm key={result.runId} runId={result.runId} />
      <div className="resultActions"><button type="button" onClick={onNewRequest}>새 요청 시작</button></div>
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
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
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
        : "허용된 근거 발췌·출처 정보·계측값만 중앙 통합 단계로 전달됩니다.";

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
    const linkedRun = new URLSearchParams(window.location.search).get("run");
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(ACTIVE_RUN_STORAGE_KEY); } catch { /* URL-based results work without browser storage. */ }
    if (linkedRun) {
      if (!/^RUN-[A-Za-z0-9-]{3,64}$/.test(linkedRun)) {
        queueMicrotask(() => setRunError("실행 ID 형식이 올바르지 않습니다."));
        return;
      }
      const controller = new AbortController();
      queueMicrotask(() => { if (!controller.signal.aborted) setRunning(true); });
      void fetchRunSnapshot(linkedRun, controller.signal).then(async (snapshot) => {
        if (controller.signal.aborted) return;
        setMode(snapshot.mode);
        const next = snapshot.result ?? await observeRun(linkedRun, snapshot.mode, controller);
        if (controller.signal.aborted) return;
        setResult(next);
        const first = next.agents.find((agent) => agent.selected);
        if (first) setActiveAgent(first.id);
      }).catch((error) => { if (!controller.signal.aborted) setRunError(error instanceof Error ? error.message : "응답을 불러오지 못했습니다."); })
        .finally(() => { if (!controller.signal.aborted) setRunning(false); });
      return () => controller.abort();
    }
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
  }, [observeRun, fetchRunSnapshot]);

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
          body: JSON.stringify({ query, mode: "proposed", commercialJudge: false }),
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
    setCancelling(false);
    setCancelError("");
    try {
      setMode("proposed");
      const next = await executeMode("proposed", modeLabels.proposed);
      setResult(next);
      const first = next.agents.find((agent) => agent.selected);
      if (first) setActiveAgent(first.id);
      await holdCompletedLiveState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "실행에 실패했습니다.";
      dispatchLiveRun({ type: "error", message });
      setRunError(message);
    } finally {
      setRunning(false);
    }
  }

  async function cancelRun() {
    const requestId = activeRequestIdRef.current;
    if (!requestId) { setCancelError("요청 접수를 확인 중입니다. 잠시 후 다시 취소해 주세요."); return; }
    setCancelling(true);
    setCancelError("");
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(requestId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("CANCEL_NOT_CONFIRMED");
      // Keep polling until the server reports a terminal state. A fetch abort is not compute termination.
    } catch {
      setCancelling(false);
      setCancelError("취소 여부를 확인하지 못했습니다. 상태 확인은 계속되며 다시 취소할 수 있습니다.");
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
    window.history.replaceState(null, "", "/");
    dispatchLiveRun({ type: "reset", mode });
  }

  const requestView = (
    <section className="focusShell requestFocus" aria-labelledby="request-title">
      <div className="requestIntro">
        <span className="serviceEyebrow">질문 입력</span>
        <h1 id="request-title">MNC FLOW</h1>
        <p>질문을 입력하면 Agent를 선택합니다.<br />선택된 Agent가 <strong>근거를 검색</strong>하고 중앙에서 답변을 통합합니다.</p>
        <p className="serviceScope">등록된 공개 문서에서 근거를 검색합니다. 비공개 정보와 개인정보는 입력하지 마세요.</p>
        <ul className="serviceRoleList" aria-label="지원하는 8개 업무 역할">{agents.map(agent => <li key={agent.id}>{agent.shortName}</li>)}</ul>
        <ol className="serviceSteps"><li>질문 입력</li><li>Agent 선택·근거 검색·답변 통합</li><li>답변과 출처 확인</li></ol>
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
            <button type="button" key={example} title={example} onClick={() => { setQuery(example); document.getElementById("work-request")?.focus(); }}>예시 {index + 1}</button>
          ))}
        </div>

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
        <button type="button" onClick={() => query.trim() ? void run() : window.location.reload()}>다시 시도</button>
        <button type="button" className="secondary" onClick={startNewRequest}>{query.trim() ? "요청 수정" : "새 요청 작성"}</button>
      </div>
    </section>
  );

  return (
    <main className="focusApp">
      <div className="focusExperience">
        <AppHeader health={llmHealth} />
        <div className="focusViewport">
          {running
            ? <FocusedProcessingPanel state={liveRun} onCancel={() => void cancelRun()} cancelling={cancelling} cancelError={cancelError} />
            : runError
              ? errorView
              : result
                ? <FocusedResultPanel result={result} activeAgent={activeAgent} onAgentChange={setActiveAgent} onNewRequest={startNewRequest} />
                : requestView}
        </div>
        <footer className="focusFooter"><span>MNC LAB</span><span>Agent 라우팅 · 근거 검색 · 답변 통합</span></footer>
      </div>
    </main>
  );
}
