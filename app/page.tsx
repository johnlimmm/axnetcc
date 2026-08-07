"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

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
  }>;
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
  integration?: {
    actor: "core-orchestrator" | "central-llm" | "managed-supervisor";
    label: string;
    backend: "ollama" | "deterministic";
    model: string | null;
  };
  status: "ready" | "review";
  routerDecision?: RouterDecisionView | null;
  evidencePlan?: EvidencePlanView | null;
  agents: AgentResult[];
  checks: { label: string; status: "pass" | "warn"; detail: string }[];
  metrics: {
    calls: number;
    tokens: number;
    bytes: number;
    latencyMs: number;
    exposedFields: number;
    traceability: number;
    rawDataLeavesEdge: boolean;
    boundaryBytes: number;
    dataRecipients: number;
    minimizationRate: number;
    privacyRiskScore: number;
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
  timeline: { label: string; detail: string; ms: number }[];
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
};

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
};

type LiveRunAction =
  | { type: "reset"; mode: RunResult["mode"]; label?: string }
  | { type: "event"; event: ProgressEvent }
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
  };
}

const exampleRequests = [
  "민원 상담용 생성형 AI 서비스를 도입하려고 합니다. 개인정보 보호, 클라우드 보안, 법적 책임과 예산 타당성을 종합 검토해 주세요.",
  "내부 연구자료 검색 AI를 구축하려고 합니다. 기술 구성과 보안 통제 방안을 중심으로 검토해 주세요.",
  "고객 응대 챗봇 외주 계약을 추진합니다. 계약상 책임과 예상 운영비를 검토해 주세요.",
  "권한경계 기밀 대응 절차를 보안과 운영 관점에서 검토해 주세요.",
];

function holdCompletedLiveState() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 320));
}

function buildFallbackResult(query: string, mode: RunResult["mode"]): RunResult {
  const lower = query.toLowerCase();
  const keywords: Record<string, string[]> = {
    tech: ["ai", "기술", "시스템", "서비스", "클라우드", "구축", "운영", "성능"],
    data: ["데이터셋", "데이터 품질", "학습데이터", "수집", "정제", "메타데이터", "가명정보"],
    security: ["보안", "개인정보", "데이터", "접근", "민원", "내부", "클라우드"],
    legal: ["법", "책임", "계약", "규정", "민원", "개인정보", "외주"],
    policy: ["정책", "윤리", "공정성", "편향", "투명성", "영향평가", "공공성"],
    finance: ["예산", "비용", "조달", "타당성", "계약", "운영비"],
    procurement: ["조달", "발주", "입찰", "규격서", "사업자", "카탈로그", "계약"],
    operations: ["운영", "sla", "장애", "모니터링", "응답시간", "품질", "유지보수"],
  };
  const selectedIds =
    mode === "proposed" || mode === "managed"
      ? agents
          .map((agent) => ({
            id: agent.id,
            score: keywords[agent.id].filter((word) => lower.includes(word)).length,
          }))
          .filter((entry) => entry.score > 0)
          .map((entry) => entry.id)
      : agents.map((agent) => agent.id);
  if (!selectedIds.length) selectedIds.push("tech");

  const content: Record<string, Omit<AgentResult, "selected" | "score" | "color" | "shortName" | "name">> = {
    tech: {
      id: "tech",
      question: "서비스 목표 달성을 위한 최소 기술 구성과 단계별 검증 기준은 무엇입니까?",
      summary: "업무망과 AI 처리영역을 분리하고, 검색 증강 생성(RAG)·응답 필터·감사 로그를 독립 모듈로 구성하는 단계적 도입이 적절합니다.",
      evidence: [
        { id: "TECH-ARCH-07", title: "AI 서비스 표준 아키텍처 v2.1", excerpt: "업무 데이터 저장소와 추론 계층의 논리적 분리" },
        { id: "OPS-SLA-03", title: "서비스 운영 SLA 지침", excerpt: "시범운영 단계 응답시간 P95 기준 정의" },
      ],
      responsibility: "디지털전략팀 기술검토 책임",
      filteredFields: ["담당자 휴대전화", "서버 관리계정"],
      latencyMs: 286,
    },
    data: {
      id: "data",
      question: "데이터 출처·품질·갱신·폐기 기준은 무엇입니까?",
      summary: "데이터 출처와 이용조건을 확인하고 품질, 최신성, 메타데이터 및 폐기 기준을 수명주기 전체에 적용해야 합니다.",
      evidence: [{ id: "DATA-GOV-01", title: "공공 AI 데이터 관리 기준", excerpt: "출처·품질·갱신주기 기록" }],
      responsibility: "데이터 관리부서 품질·수명주기 검토",
      filteredFields: [],
      latencyMs: 301,
    },
    security: {
      id: "security",
      question: "개인정보와 내부정보를 보호하기 위한 필수 통제 및 반출 제한은 무엇입니까?",
      summary: "원문은 조직 Edge에 유지하고 최소 질의만 전달해야 합니다. 민감정보 마스킹, 역할 기반 접근통제, 프롬프트·응답 감사가 필수입니다.",
      evidence: [
        { id: "SEC-POL-12", title: "생성형 AI 보안정책", excerpt: "민감정보의 외부 추론환경 전송 금지" },
        { id: "PRIV-GUIDE-04", title: "개인정보 처리 가이드", excerpt: "목적 달성에 필요한 최소 항목만 처리" },
      ],
      responsibility: "정보보호팀 보안성 검토",
      filteredFields: ["주민등록번호", "민원인 연락처", "내부 IP"],
      latencyMs: 342,
    },
    legal: {
      id: "legal",
      question: "관련 법령·계약 조건과 AI 산출물의 검토 책임을 어떻게 규정해야 합니까?",
      summary: "AI 결과는 보조 판단으로 한정하고 담당자의 최종 검토를 명시해야 합니다. 위탁 처리 시 데이터 이용범위·재위탁·사고책임 조항이 필요합니다.",
      evidence: [
        { id: "LEGAL-AI-09", title: "AI 활용 업무 법률 검토서", excerpt: "자동화된 결과에 대한 담당자 최종 검토 의무" },
        { id: "CONT-DPA-02", title: "데이터 처리 위탁 표준조항", excerpt: "목적 외 처리와 재위탁 제한" },
      ],
      responsibility: "법무팀 규정·계약 검토",
      filteredFields: ["계약 상대방 개인주소"],
      latencyMs: 318,
    },
    policy: {
      id: "policy",
      question: "공공성·투명성·편향 및 영향평가 기준은 무엇입니까?",
      summary: "정책 목적과 권리 영향을 명시하고 설명가능성, 편향 점검, 이의제기 절차를 운영해야 합니다.",
      evidence: [{ id: "POLICY-AI-01", title: "공공 AI 도입 원칙", excerpt: "투명성·책임성·영향평가" }],
      responsibility: "AI 정책담당 공공성·영향평가 검토",
      filteredFields: [],
      latencyMs: 329,
    },
    finance: {
      id: "finance",
      question: "시범도입과 운영 단계의 비용항목 및 조달상 확인사항은 무엇입니까?",
      summary: "PoC·본사업을 분리하고 사용량 기반 추론비, 보안검증비, 운영인력 비용을 총소유비용에 포함해야 합니다. 경쟁성 검토가 선행돼야 합니다.",
      evidence: [
        { id: "FIN-TCO-11", title: "정보화사업 TCO 산정표", excerpt: "구축비 외 3개년 운영·추론 비용 포함" },
        { id: "PROC-STD-06", title: "디지털서비스 조달지침", excerpt: "규격서 작성 전 경쟁성·종속성 검토" },
      ],
      responsibility: "재무·구매팀 예산 타당성 검토",
      filteredFields: ["개별 인건비 단가"],
      latencyMs: 254,
    },
    procurement: {
      id: "procurement",
      question: "발주 방식과 경쟁성, 사업자 종속 위험은 무엇입니까?",
      summary: "측정 가능한 규격과 경쟁성, 데이터 이전·계약 종료 조건을 명시해야 합니다.",
      evidence: [{ id: "PROC-CAT-01", title: "디지털서비스 계약 안내", excerpt: "카탈로그 계약과 평가 절차" }],
      responsibility: "구매·계약부서 발주·경쟁성 검토",
      filteredFields: [],
      latencyMs: 276,
    },
    operations: {
      id: "operations",
      question: "SLA·장애대응·품질측정과 운영 전환 기준은 무엇입니까?",
      summary: "응답시간·가용성·정확성 지표와 장애 대응 및 운영 전환 게이트를 정의해야 합니다.",
      evidence: [{ id: "OPS-SLA-01", title: "AI 서비스 운영 기준", excerpt: "SLA·모니터링·운영 전환 조건" }],
      responsibility: "서비스 운영부서 SLA·품질 검토",
      filteredFields: [],
      latencyMs: 297,
    },
  };

  const agentResults = agents.map((agent) => {
    const score = keywords[agent.id].filter((word) => lower.includes(word)).length;
    return {
      ...agent,
      ...content[agent.id],
      selected: selectedIds.includes(agent.id),
      score: Math.min(99, 62 + score * 8),
    };
  });
  const calls = mode === "centralized" ? 1 : selectedIds.length + (mode === "managed" ? 1 : 0);
  const baseTokens = mode === "centralized" ? 6940 : calls * 790 + 620;
  const exposedFields = mode === "proposed" ? 0 : mode === "parallel" ? 7 : 12;
  return {
    runId: "RUN-PREVIEW",
    mode,
    title: "신규 AI 서비스 도입 종합 검토",
    conclusion:
      "제한적 시범 도입을 권고합니다. 원문 데이터의 Edge 보존, 역할 기반 접근통제, 담당자 최종 검토를 선행조건으로 설정하고 PoC 이후 품질·보안·비용 지표를 재평가해야 합니다.",
    status: selectedIds.includes("security") && selectedIds.includes("legal") ? "ready" : "review",
    agents: agentResults,
    checks: [
      { label: "필수 검토영역", status: calls >= 2 ? "pass" : "warn", detail: `${calls}개 전문영역의 판단을 반영했습니다.` },
      { label: "근거 완전성", status: "pass", detail: "모든 핵심 판단에 근거 식별자가 연결되었습니다." },
      { label: "응답 충돌", status: "warn", detail: "기술 편의성과 보안상 데이터 반출 제한 사이에 조건부 조정이 필요합니다." },
      { label: "민감정보", status: exposedFields === 0 ? "pass" : "warn", detail: exposedFields === 0 ? "Edge 반환 전 필터링되었습니다." : `${exposedFields}개 불필요 필드가 전달되었습니다.` },
    ],
    metrics: {
      calls,
      tokens: baseTokens,
      bytes: mode === "proposed" ? calls * 1840 : mode === "parallel" ? 14680 : mode === "managed" ? 29600 : 42800,
      latencyMs: mode === "proposed" ? 1120 : mode === "parallel" ? 1540 : mode === "managed" ? 2140 : 1890,
      exposedFields,
      traceability: mode === "proposed" ? 100 : mode === "parallel" ? 72 : mode === "managed" ? 82 : 35,
      rawDataLeavesEdge: false,
      boundaryBytes: mode === "centralized" ? 42800 : mode === "managed" ? 29600 : mode === "parallel" ? 14680 : calls * 1840,
      dataRecipients: mode === "centralized" ? 1 : calls,
      minimizationRate: mode === "centralized" || mode === "managed" ? 0 : mode === "parallel" ? 66 : 78,
      privacyRiskScore: mode === "centralized" ? 85 : mode === "managed" ? 76 : mode === "parallel" ? 62 : Math.min(35, 8 + calls * 3),
      groundedness: mode === "proposed" ? 88 : mode === "managed" ? 82 : mode === "parallel" ? 76 : 68,
      relevance: mode === "proposed" ? 90 : mode === "managed" ? 84 : mode === "parallel" ? 80 : 72,
      evidenceSupport: mode === "proposed" ? 88 : mode === "managed" ? 82 : mode === "parallel" ? 76 : 68,
      citationCoverage: mode === "proposed" ? 92 : mode === "managed" ? 84 : mode === "parallel" ? 78 : 62,
      citationValidity: mode === "proposed" ? 96 : 88,
      domainCoverage: 100,
      answerCompleteness: mode === "proposed" ? 90 : 86,
      qualityScore: mode === "proposed" ? 92 : mode === "managed" ? 86 : mode === "parallel" ? 82 : 74,
      llmBackend: "deterministic",
      model: "qwen2.5:3b",
      ttftMs: null,
      tpotMs: null,
    },
    timeline: [
      { label: "요청 분석", detail: "업무영역·의도·민감도 분류", ms: 74 },
      { label: "Agent 선택", detail: `${calls}개 역할 및 접근권한 일치`, ms: 31 },
      { label: "최소 질의 생성", detail: "조직별 허용 필드만 포함", ms: 48 },
      { label: "Edge Local RAG", detail: "원문은 Edge 내부에서만 검색", ms: 721 },
      { label: "검증·통합", detail: "근거·충돌·검토주체 연결", ms: 246 },
    ],
  };
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
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

function EvidencePlanCard({ plan, compact = false }: { plan: EvidencePlanView; compact?: boolean }) {
  const coverageLabel = plan.coverage === null ? "UNKNOWN" : `${Math.round(plan.coverage * 100)}%`;
  return (
    <section className={`evidencePlanCard ${plan.humanReviewRequired ? "review" : "verified"} ${compact ? "compact" : ""}`} aria-label="Edge 근거 충족 계획">
      <header>
        <div><span>EDGE EVIDENCE GATE</span><strong>필수 개념 충족도와 실제 공개 방식을 확인했습니다</strong></div>
        <b>{plan.humanReviewRequired ? "HUMAN REVIEW" : "VERIFIED"}</b>
      </header>
      <div className="evidenceCoverageRow">
        <strong>{coverageLabel}</strong>
        <div><span style={{ width: `${plan.coverage === null ? 0 : Math.round(plan.coverage * 100)}%` }} /></div>
        <small>충족 {plan.coveredConceptIds.length} · 미충족 {plan.missingConceptIds.length}</small>
      </div>
      {!compact && (
        <div className="evidenceAgentPlans">
          {plan.agentPlans.map((agentPlan) => (
            <div key={agentPlan.agentId}>
              <strong>{agentLabel(agentPlan.agentId)} Agent</strong>
              <span className={`planStatus ${agentPlan.status}`}>{agentPlan.status}</span>
              <small>{agentPlan.coverage === null ? "coverage unknown" : `${Math.round(agentPlan.coverage * 100)}% coverage`}</small>
              <p>{agentPlan.modes.length ? agentPlan.modes.map((mode) => <b key={mode}>{mode}</b>) : <b>metadata only</b>}</p>
            </div>
          ))}
        </div>
      )}
      {!!plan.missingConceptIds.length && <p className="missingConcepts">미충족: {plan.missingConceptIds.join(" · ")}</p>}
    </section>
  );
}

function LiveExecutionPanel({ state }: { state: LiveRunState }) {
  const selectedAgents = agents.filter((agent) => state.agents[agent.id]?.selected === true);
  const completedAgents = selectedAgents.filter((agent) => {
    const stage = state.agents[agent.id]?.stage;
    return stage === "completed" || stage === "fallback" || stage === "mapped";
  });
  const completion = state.core.stage === "completed"
    ? 100
    : selectedAgents.length
    ? Math.min(94, Math.round(completedAgents.length / selectedAgents.length * 76) + 8)
    : 6;
  const isCentralAgentMapping = state.mode === "centralized" || state.mode === "remoterag";
  const coreMeta = state.core.kind === "managed-supervisor"
    ? {
        eyebrow: "MANAGED INTEGRATION",
        title: "Managed Supervisor",
        detail: "전문 Agent 응답·근거를 중앙 모델이 최종 통합",
      }
    : state.core.kind === "central-llm"
      ? {
          eyebrow: "CENTRAL INFERENCE",
          title: state.mode === "proposed" ? "AXNetCC 중앙 통합 모델" : "중앙 Core LLM",
          detail: state.mode === "proposed"
            ? "Edge Agent의 안전 요약·근거 ID만 통합"
            : "중앙 RAG 검색과 단일 모델 응답 생성",
        }
      : {
          eyebrow: "GOVERNANCE CORE",
          title: "Core Orchestrator",
          detail: "Agent 선택·근거 검증·충돌 조정",
        };
  const coreStageLabel: Record<LiveCoreStage, string> = {
    routing: "요청 분석 중",
    retrieving: "중앙 RAG 검색 중",
    generating: "중앙 응답 생성 중",
    integrating: state.core.kind === "core-orchestrator" ? "응답 검증·통합 중" : "중앙 모델 통합 중",
    judging: "품질 평가 중",
    completed: "최종 통합 완료",
    error: "실행 오류",
  };
  const agentStageLabel: Record<LiveAgentStage, string> = {
    idle: "라우팅 대기 중",
    queued: "실행 순서 대기 중",
    retrieving: "RAG에서 근거 검색 중…",
    retrieved: "근거 검색 완료",
    generating: isCentralAgentMapping ? "중앙 응답에 근거 연결 중…" : "응답 생성하는 중…",
    mapping: "중앙 응답에 전문 근거 연결 중…",
    completed: "응답 생성 완료",
    mapped: "전문 근거 매핑 완료",
    fallback: "근거 기반 Fallback 완료",
    skipped: "이번 요청에서 제외됨",
    error: "실행 오류",
  };

  function miniStepClass(stage: LiveAgentStage, step: "rag" | "model" | "done") {
    if (stage === "skipped" || stage === "idle" || stage === "queued") return "";
    if (step === "rag") return stage === "retrieving" ? "active" : "done";
    if (step === "model") {
      if (stage === "retrieved" || stage === "generating" || stage === "mapping") return "active";
      return stage === "completed" || stage === "fallback" || stage === "mapped" ? "done" : "";
    }
    return stage === "completed" || stage === "mapped" ? "done" : stage === "fallback" ? "warning" : "";
  }

  return (
    <div className="resultPanel liveExecutionPanel">
      <div className="liveRunTop">
        <div>
          <span className="liveRunKicker"><i /> LIVE ORCHESTRATION</span>
          <strong>{state.runId ?? "RUN 준비 중"}</strong>
          <small>{modeLabels[state.mode]}</small>
        </div>
        <div className="liveRunCount">
          <strong>{completedAgents.length}<span> / {selectedAgents.length || "-"}</span></strong>
          <small>Agent 응답 완료</small>
        </div>
      </div>

      <div className="liveProgress" aria-hidden="true">
        <span style={{ width: `${completion}%` }} />
      </div>
      <p className="liveNow" aria-live="polite"><span className="spinner dark" />{state.message}</p>

      {state.routerDecision && <RouterDecisionCard decision={state.routerDecision} compact />}

      <section className={`liveCore stage-${state.core.stage}`}>
        <div className="coreSignal" aria-hidden="true">
          <i /><i /><i /><b>CORE</b>
        </div>
        <div className="liveCoreCopy">
          <span>{coreMeta.eyebrow}</span>
          <strong>{coreMeta.title}</strong>
          <p>{coreMeta.detail}</p>
        </div>
        <div className="liveCoreStatus">
          <span><i />{coreStageLabel[state.core.stage]}</span>
          <small>{state.core.model ?? (state.core.kind === "core-orchestrator" ? "정책 기반 결정론적 통합" : "모델 연결 확인 중")}</small>
          {state.core.backend && <b>{state.core.backend === "ollama" ? "LOCAL LLM" : "DETERMINISTIC FALLBACK"}</b>}
          {state.core.evidenceCount > 0 && <b>근거 {state.core.evidenceCount}건</b>}
        </div>
      </section>

      <div className="flowDivider" aria-hidden="true"><span>EDGE AGENT EXECUTION</span></div>
      <div className="liveAgentGrid">
        {agents.map((agent) => {
          const live = state.agents[agent.id];
          const stage = live?.stage ?? "idle";
          return (
            <article
              key={agent.id}
              className={`liveAgentCard stage-${stage}`}
              style={{ "--agent": agent.color } as React.CSSProperties}
            >
              <header>
                <i>{agent.shortName.slice(0, 1)}</i>
                <div><strong>{agent.shortName} Agent</strong><small>{agent.detail}</small></div>
                <span className="agentStateDot" />
              </header>
              <div className="agentMiniFlow" aria-label={`${agent.shortName} Agent 실행 단계`}>
                <span className={miniStepClass(stage, "rag")}>RAG</span><i />
                <span className={miniStepClass(stage, "model")}>{isCentralAgentMapping ? "MAP" : "LLM"}</span><i />
                <span className={miniStepClass(stage, "done")}>DONE</span>
              </div>
              <p>{agentStageLabel[stage]}</p>
              <footer>
                <span>{live?.evidenceCount ? `근거 ${live.evidenceCount}건` : live?.selected === false ? "미호출" : "근거 대기"}</span>
                <span>{stage === "mapping" || stage === "mapped" ? "EVIDENCE MAP" : live?.backend === "ollama" ? "LOCAL LLM" : live?.backend === "deterministic" ? "FALLBACK" : "EDGE"}</span>
              </footer>
            </article>
          );
        })}
      </div>

      {state.evidencePlan && <EvidencePlanCard plan={state.evidencePlan} compact />}

      <section className="liveActivity">
        <div><strong>실시간 실행 로그</strong><small>민감 원문을 제외한 상태 메타데이터만 표시합니다.</small></div>
        <ol>
          {state.activity.map((item) => (
            <li key={item.sequence}><b>{String(item.sequence).padStart(2, "0")}</b><span>{item.message}</span></li>
          ))}
        </ol>
      </section>
    </div>
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
              return (
                <article key={agent.id} className={finished ? "finished" : "working"} style={{ "--agent": agent.color } as React.CSSProperties}>
                  <i aria-hidden="true">{agent.shortName.slice(0, 1)}</i>
                  <div><span>{role}</span><strong>{agent.shortName} Agent</strong><small>{agentLiveLabel(live.stage)}</small></div>
                  <b>{live.evidenceCount > 0 ? `근거 ${live.evidenceCount}건` : finished ? "수신 완료" : "수신 중"}</b>
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
  const primaryId = result.routerDecision?.primaryAgent;
  const primarySelection = result.routerDecision?.primarySelection;
  const confidence = primarySelection
    ? Math.round((primarySelection.confidence <= 1 ? primarySelection.confidence * 100 : primarySelection.confidence))
    : null;
  const margin = primarySelection
    ? Math.round((primarySelection.top1Top2Margin <= 1 ? primarySelection.top1Top2Margin * 100 : primarySelection.top1Top2Margin))
    : null;

  return (
    <section className="focusShell finalFocus" aria-labelledby="final-result-title">
      <FocusStepper activeStep={4} />
      <header className="finalHero">
        <div className="finalCheck" aria-hidden="true">{"\u2713"}</div>
        <div>
          <span>REQUEST COMPLETED · {result.runId}</span>
          <h1 id="final-result-title">{result.title}</h1>
          <p>{result.conclusion}</p>
        </div>
        <b className={result.status}>{result.status === "ready" ? "응답 완료" : "검토 필요"}</b>
      </header>

      <div className="answerOverview">
        <section>
          <span>FINAL RESPONSE</span>
          <h2>중앙 통합 응답</h2>
          <p>{result.conclusion}</p>
          <small>{result.integration?.label ?? "Core Orchestrator"} · {result.integration?.backend === "ollama" ? result.integration.model : "안전 응답 모드"}</small>
        </section>
        <aside>
          <span>RESPONSE BASIS</span>
          <strong>{selectedAgents.reduce((sum, agent) => sum + agent.evidence.length, 0)}건</strong>
          <p>{selectedAgents.length}개 기관의 근거를 연결했습니다.</p>
          <div>{selectedAgents.map((agent) => <b key={agent.id}>{agent.shortName}</b>)}</div>
        </aside>
      </div>

      <section className="resultEvidence" aria-labelledby="evidence-title">
        <header>
          <div><span>TRACEABLE EVIDENCE</span><h2 id="evidence-title">Agent 응답과 근거</h2></div>
          <p>기관을 선택하면 해당 Agent가 전달한 안전 요약과 근거를 확인할 수 있습니다.</p>
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
          <article className="agentAnswer">
            <span>AGENT RESPONSE</span>
            <h3>{selected.shortName} Agent의 검토 의견</h3>
            <p>{selected.summary}</p>
            <div className="responsibility"><strong>검토 주체</strong><span>{selected.responsibility}</span></div>
          </article>
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
            }) : <p className="noEvidence">표시할 수 있는 근거가 없습니다. 상세 진단에서 근거 게이트 상태를 확인하세요.</p>}
          </div>
        </div>
      </section>

      <details className="resultDiagnostics">
        <summary><span><strong>라우팅·보안·성능 상세 진단</strong><small>주관기관 선택 근거와 감사 정보를 펼쳐 봅니다.</small></span><b>펼치기</b></summary>
        <div className="diagnosticBody">
          {primarySelection && (
            <section className="selectionDiagnostic" aria-label="주관기관 선택 점수 상세">
              <header><div><span>PRIMARY SELECTION</span><strong>주관기관 선택 근거</strong></div><p>신뢰도 <b>{confidence}%</b> · 1위와 2위의 차이 <b>{margin}%p</b></p></header>
              <div>
                {primarySelection.rankedCandidates.slice(0, 3).map((candidate) => (
                  <article key={candidate.agentId}>
                    <span>{candidate.rank}위</span><strong>{agentLabel(candidate.agentId)} Agent</strong><b>{candidate.totalScore.toFixed(3)}</b>
                  </article>
                ))}
              </div>
              <p>{primarySelection.hardGate.applied
                ? `필수 정책 규칙 적용 · ${primarySelection.hardGate.reasons.join(" · ")}`
                : `${primarySelection.algorithm} · 임계값 ${primarySelection.decisionThreshold}`}</p>
            </section>
          )}
          {result.routerDecision && <RouterDecisionCard decision={result.routerDecision} />}
          {result.evidencePlan && <EvidencePlanCard plan={result.evidencePlan} />}
          <section className="compactDiagnostics">
            <div><span>Agent 호출</span><strong>{result.metrics.calls}회</strong></div>
            <div><span>처리 지연</span><strong>{(result.metrics.latencyMs / 1000).toFixed(2)}초</strong></div>
            <div><span>Core 전송량</span><strong>{(result.metrics.boundaryBytes / 1024).toFixed(1)}KB</strong></div>
            <div><span>추적 가능성</span><strong>{result.metrics.traceability}%</strong></div>
          </section>
          <section className="diagnosticChecks">
            {result.checks.map((check) => <p key={check.label}><b className={check.status}>{check.status === "pass" ? "\u2713" : "!"}</b><span><strong>{check.label}</strong><small>{check.detail}</small></span></p>)}
          </section>
          <ol className="compactTimeline">
            {result.timeline.map((item, index) => <li key={item.label}><b>{index + 1}</b><span><strong>{item.label}</strong><small>{item.detail}</small></span><em>{item.ms} ms</em></li>)}
          </ol>
        </div>
      </details>

      <div className="resultActions"><button type="button" onClick={onNewRequest}>새 요청 시작</button><Link href="/evaluation">성능 평가 결과 보기</Link></div>
    </section>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RunResult["mode"]>("proposed");
  const [result, setResult] = useState<RunResult>(() => buildFallbackResult(exampleRequests[0], "proposed"));
  const [benchmarks, setBenchmarks] = useState<Partial<Record<RunResult["mode"], RunResult>>>({});
  const [llmHealth, setLlmHealth] = useState<LlmHealth | null>(null);
  const [running, setRunning] = useState(false);
  const [runProgress, setRunProgress] = useState("");
  const [hasRun, setHasRun] = useState(false);
  const [runError, setRunError] = useState("");
  const [commercialJudgeEnabled, setCommercialJudgeEnabled] = useState(false);
  const [activeAgent, setActiveAgent] = useState("security");
  const [liveRun, dispatchLiveRun] = useReducer(liveRunReducer, createLiveRunState("proposed"));
  const streamControllerRef = useRef<AbortController | null>(null);
  const selectedResult = result.agents.find((agent) => agent.id === activeAgent) ?? result.agents[0];
  const selectedCount = running
    ? Object.values(liveRun.agents).filter((agent) => agent.selected).length
    : hasRun ? result.agents.filter((agent) => agent.selected).length : 0;
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

  const comparison = useMemo(() => {
    return [
      { id: "centralized" as const, name: "중앙집중형" },
      { id: "parallel" as const, name: "병렬 Multi-Agent" },
      { id: "managed" as const, name: "Managed Supervisor" },
      { id: "masrouter" as const, name: "MasRouter-inspired" },
      { id: "remoterag" as const, name: "RemoteRAG-inspired" },
      { id: "proposed" as const, name: "제안 방식" },
    ].map((item) => ({
      ...item,
      metrics: benchmarks[item.id]?.metrics ?? buildFallbackResult(query, item.id).metrics,
      judge: benchmarks[item.id]?.commercialJudge,
      measured: Boolean(benchmarks[item.id]),
    }));
  }, [benchmarks, query]);
  const liveComparison = useMemo(() => {
    const measured = comparison.filter((row) => row.measured);
    const judged = measured.filter((row) => row.judge?.overall != null);
    const bestQuality = judged.length
      ? Math.max(...judged.map((row) => row.judge?.overall ?? 0))
      : null;
    const proposed = measured.find((row) => row.id === "proposed");
    const centralized = measured.find((row) => row.id === "centralized");
    return {
      complete: measured.length === 6 && judged.length === 6,
      bestQuality,
      qualityRetention:
        proposed?.judge?.overall != null && bestQuality
          ? Math.round(proposed.judge.overall / bestQuality * 100)
          : null,
      boundaryGain:
        proposed && centralized && centralized.metrics.boundaryBytes
          ? Math.round((1 - proposed.metrics.boundaryBytes / centralized.metrics.boundaryBytes) * 100)
          : null,
    };
  }, [comparison]);

  async function executeMode(targetMode: RunResult["mode"], label?: string): Promise<RunResult> {
    streamControllerRef.current?.abort();
    const controller = new AbortController();
    streamControllerRef.current = controller;
    dispatchLiveRun({ type: "reset", mode: targetMode, label });

    try {
      const response = await fetch("/api/orchestrate/stream", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ query, mode: targetMode, commercialJudge: commercialJudgeEnabled }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? "오케스트레이션 요청에 실패했습니다.");
      }
      if (!response.body) throw new Error("진행 스트림을 열 수 없습니다.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const outcome: { result?: RunResult } = {};
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const packet = JSON.parse(line) as
          | { type: "progress"; event: ProgressEvent }
          | { type: "result"; result: RunResult }
          | { type: "error"; error: string };
        if (packet.type === "progress") dispatchLiveRun({ type: "event", event: packet.event });
        if (packet.type === "result") outcome.result = packet.result;
        if (packet.type === "error") throw new Error(packet.error);
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);
      if (!outcome.result) throw new Error("최종 실행 결과가 전달되지 않았습니다.");
      return outcome.result;
    } finally {
      if (streamControllerRef.current === controller) streamControllerRef.current = null;
    }
  }

  async function run() {
    setRunning(true);
    setRunError("");
    setRunProgress("선택 방식 실행 중");
    try {
      const next = await executeMode(mode, modeLabels[mode]);
      setResult(next);
      setHasRun(true);
      setBenchmarks((current) => ({ ...current, [next.mode]: next }));
      const first = next.agents.find((agent) => agent.selected);
      if (first) setActiveAgent(first.id);
      await holdCompletedLiveState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "실행에 실패했습니다.";
      dispatchLiveRun({ type: "error", message });
      setRunError(`${message} Local LLM 연결 상태를 확인한 뒤 다시 시도해 주세요.`);
    } finally {
      setRunning(false);
      setRunProgress("");
    }
  }

  async function runAllModes() {
    setRunning(true);
    setRunError("");
    setBenchmarks({});
    const sequence: Array<{ mode: RunResult["mode"]; label: string }> = [
      { mode: "centralized", label: "중앙집중형" },
      { mode: "parallel", label: "전체 Multi-Agent" },
      { mode: "managed", label: "Managed Supervisor" },
      { mode: "masrouter", label: "MasRouter-inspired" },
      { mode: "remoterag", label: "RemoteRAG-inspired" },
      { mode: "proposed", label: "제안 방식" },
    ];
    try {
      for (let index = 0; index < sequence.length; index += 1) {
        const item = sequence[index];
        setRunProgress(`${index + 1}/${sequence.length} ${item.label} 실측 중`);
        const next = await executeMode(item.mode, `${index + 1}/${sequence.length} ${item.label}`);
        setBenchmarks((current) => ({ ...current, [next.mode]: next }));
        setResult(next);
        setHasRun(true);
        const first = next.agents.find((agent) => agent.selected);
        if (first) setActiveAgent(first.id);
        await holdCompletedLiveState();
      }
      setMode("proposed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "전체 비교 실행이 중단되었습니다.";
      dispatchLiveRun({ type: "error", message });
      setRunError(`${message} 연결 상태를 확인한 뒤 다시 시도해 주세요.`);
    } finally {
      setRunning(false);
      setRunProgress("");
    }
  }

  function startNewRequest() {
    streamControllerRef.current?.abort();
    setHasRun(false);
    setRunError("");
    setRunProgress("");
    setQuery("");
    dispatchLiveRun({ type: "reset", mode });
  }

  const requestView = (
    <section className="focusShell requestFocus" aria-labelledby="request-title">
      <div className="requestIntro">
        <span>BOUNDARY-CONSTRAINED MULTI-AGENT</span>
        <h1 id="request-title">요청을 입력하면<br /><em>적합한 주관기관부터 찾습니다.</em></h1>
        <p>중앙 Router가 요청의 의미와 필수 검토 규칙을 분석하고, 선택된 Agent의 근거만 안전하게 통합합니다.</p>
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
              : hasRun
                ? <FocusedResultPanel result={result} activeAgent={activeAgent} onAgentChange={setActiveAgent} onNewRequest={startNewRequest} />
                : requestView}
        </div>
        <footer className="focusFooter"><span>MNC Lab. · Korea University</span><span>KOREN 기반 분산 AI Agent 협력 거버넌스 플랫폼</span></footer>
      </div>
    </main>
  );
}
