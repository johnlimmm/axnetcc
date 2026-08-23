"use client";

import { useEffect, useState } from "react";

type MetricProvenance = {
  kind?: "measured" | "derived" | "estimated" | "unavailable";
  source?: string;
  method?: string;
};

type PrivacyRisk = {
  privacyRiskVersion?: string;
  score?: number | null;
  sensitiveDetectedCount?: number | null;
  sensitiveTransmittedCount?: number | null;
  sensitiveTransmissionRatio?: number | null;
  selectedAgentCount?: number | null;
  totalAgentCount?: number | null;
  agentSelectionRatio?: number | null;
  originalBytes?: number | null;
  transmittedOriginalBytes?: number | null;
  originalDisclosureRatio?: number | null;
  egressEnvelopeCount?: number | null;
  recipientCount?: number | null;
  privacyPass?: boolean;
  outputLeak?: boolean;
};

type RunMetrics = {
  calls?: number | null;
  agentCalls?: number | null;
  integrationCalls?: number | null;
  tokens?: number | null;
  tokenBreakdown?: {
    inferenceCount?: number | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  } | null;
  latencyMs?: number | null;
  latencyBreakdown?: {
    queueWaitMs?: number | null;
    inferenceMs?: number | null;
    endToEndMs?: number | null;
  } | null;
  boundaryBytes?: number | null;
  rawDataLeavesEdge?: boolean;
  dataRecipients?: number | null;
  minimizationRate?: number | null;
  privacyRiskScore?: number | null;
  privacyRisk?: PrivacyRisk | null;
  groundedness?: number | null;
  relevance?: number | null;
  evidenceSupport?: number | null;
  citationCoverage?: number | null;
  citationValidity?: number | null;
  citationRecall?: number | null;
  claimSupportRate?: number | null;
  retrievalSuccessRate?: number | null;
  evidenceUtilizationRate?: number | null;
  domainCoverage?: number | null;
  answerCompleteness?: number | null;
  qualityScore?: number | null;
  ragChunks?: number | null;
  llmBackend?: string;
  model?: string;
  ttftMs?: number | null;
  tpotMs?: number | null;
  provenance?: {
    fields?: Record<string, MetricProvenance>;
  };
};

type RoutingCandidate = {
  agentId?: string;
  rank?: number;
  totalScore?: number;
  matchedTerms?: string[];
  matchedEntities?: string[];
  matchedConceptIds?: string[];
};

type RunResult = {
  mode?: string;
  status?: string;
  integration?: {
    label?: string;
    backend?: string;
    model?: string | null;
  };
  routerDecision?: {
    primaryAgent?: string;
    selected?: string[];
    supportingAgents?: string[];
    predictedCoverage?: number | null;
    objectiveCost?: number | null;
    humanReviewRequired?: boolean;
    primarySelection?: {
      algorithm?: string;
      confidence?: number | null;
      top1Top2Margin?: number | null;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      rankedCandidates?: RoutingCandidate[];
    };
  } | null;
  evidencePlan?: {
    coverage?: number | null;
    coveredConceptIds?: string[];
    missingConceptIds?: string[];
    humanReviewRequired?: boolean;
    agentPlans?: Array<{
      agentId?: string;
      status?: string;
      coverage?: number | null;
      modes?: string[];
      transfers?: Array<{
        referenceId?: string;
        plannedMode?: string;
        appliedMode?: string;
        egressBytes?: number | null;
      }>;
    }>;
  } | null;
  execution?: {
    executionStatus?: string;
    scheduling?: {
      policy?: string;
      scheduledTaskCount?: number | null;
    };
    tasks?: Array<{
      taskId?: string;
      kind?: string;
      assignee?: string;
      status?: string;
      queuePosition?: number | null;
      waitingMs?: number | null;
    }>;
  };
  metrics?: RunMetrics;
  commercialJudge?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    correctness?: number | null;
    groundedness?: number | null;
    completeness?: number | null;
    overall?: number | null;
    error?: string;
  };
  checks?: Array<{ label?: string; status?: string; detail?: string }>;
  timeline?: Array<{
    label?: string;
    detail?: string;
    ms?: number | null;
    queueWaitMs?: number | null;
    inferenceMs?: number | null;
    provenance?: string;
  }>;
};

type RunSnapshot = {
  requestId: string;
  mode?: string;
  status?: string;
  completedAt?: number | null;
  progress?: {
    totalCount?: number;
    terminalCount?: number;
    remainingCount?: number;
  };
  result?: RunResult;
};

type LoadState =
  | { kind: "idle" }
  | { kind: "loading"; runId: string }
  | { kind: "pending"; runId: string; snapshot: RunSnapshot }
  | { kind: "ready"; runId: string; snapshot: RunSnapshot; result: RunResult }
  | { kind: "error"; runId?: string; message: string };

const terminalStatuses = new Set(["completed", "partial_failed", "failed", "cancelled"]);

const modeLabels: Record<string, string> = {
  centralized: "Single Centralized RAG",
  managed: "Managed Agent",
  parallel: "All-Agent Aggregation",
  masrouter: "MasRouter-inspired",
  remoterag: "RemoteRAG-inspired",
  proposed: "제안 방식",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decimal(value: unknown, digits = 1, suffix = "") {
  return finite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function integer(value: unknown, suffix = "") {
  return finite(value) ? `${Math.round(value).toLocaleString()}${suffix}` : "—";
}

function score(value: unknown) {
  return finite(value) ? `${value.toFixed(1)} / 100` : "—";
}

function ratio(value: unknown) {
  return finite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function bytes(value: unknown) {
  if (!finite(value)) return "—";
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${Math.round(value).toLocaleString()} B`;
}

function milliseconds(value: unknown) {
  if (!finite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}초` : `${Math.round(value).toLocaleString()}ms`;
}

function booleanLabel(value: unknown, trueLabel: string, falseLabel: string) {
  return typeof value === "boolean" ? (value ? trueLabel : falseLabel) : "—";
}

function normalizedPercent(value: unknown) {
  if (!finite(value)) return "—";
  return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`;
}

function provenanceTitle(provenance: MetricProvenance | undefined) {
  if (!provenance) return undefined;
  return [provenance.kind, provenance.source, provenance.method].filter(Boolean).join(" · ");
}

function MetricCard({
  label,
  value,
  detail,
  provenance,
}: {
  label: string;
  value: string;
  detail?: string;
  provenance?: MetricProvenance;
}) {
  return (
    <div className="latestRunMetric" title={provenanceTitle(provenance)}>
      <b>{label}</b>
      <strong>{value}</strong>
      {detail ? <p>{detail}</p> : null}
      {provenance?.kind ? <small>{provenance.kind}</small> : null}
    </div>
  );
}

export default function LatestRunEvaluation() {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  useEffect(() => {
    const runId = new URLSearchParams(window.location.search).get("run")?.trim();
    if (!runId) return;
    if (!/^RUN-[A-Za-z0-9-]{3,64}$/.test(runId)) {
      queueMicrotask(() => setState({ kind: "error", message: "실행 ID 형식이 올바르지 않습니다." }));
      return;
    }

    const controller = new AbortController();
    let timer: number | undefined;
    queueMicrotask(() => {
      if (!controller.signal.aborted) setState({ kind: "loading", runId });
    });

    const load = async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP_${response.status}`;
          throw new Error(code === "RUN_NOT_FOUND" ? "실행 결과가 만료되었거나 존재하지 않습니다." : `실행 결과 조회 실패: ${code}`);
        }
        if (!isRecord(payload) || typeof payload.requestId !== "string") {
          throw new Error("실행 결과 응답 형식이 올바르지 않습니다.");
        }

        const snapshot = payload as unknown as RunSnapshot;
        if (snapshot.result && isRecord(snapshot.result)) {
          setState({ kind: "ready", runId, snapshot, result: snapshot.result });
          return;
        }

        setState({ kind: "pending", runId, snapshot });
        if (!terminalStatuses.has(snapshot.status ?? "")) {
          timer = window.setTimeout(() => void load(), 1_000);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          runId,
          message: error instanceof Error ? error.message : "실행 결과를 불러오지 못했습니다.",
        });
      }
    };

    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (state.kind === "idle") {
    return (
      <article id="latest-run-evaluation" className="latestRunEvaluation">
        <div className="evaluationSectionHead">
          <span>01</span>
          <div><h2>최근 실행 성능 진단</h2><p>결과 화면에서 ‘이 실행의 평가 결과 보기’를 선택하면 해당 실행의 측정값을 여기에서 확인할 수 있습니다.</p></div>
        </div>
        <p className="evaluationClaim">선택된 실행이 없습니다. 개별 실행 지표는 <code>/evaluation?run=RUN-ID</code> 주소로 연결됩니다.</p>
      </article>
    );
  }

  if (state.kind === "loading") {
    return (
      <article id="latest-run-evaluation" className="latestRunEvaluation" aria-busy="true">
        <div className="evaluationSectionHead"><span>01</span><div><h2>최근 실행 성능 진단</h2><p>{state.runId}의 측정 결과를 불러오는 중입니다.</p></div></div>
      </article>
    );
  }

  if (state.kind === "error") {
    return (
      <article id="latest-run-evaluation" className="latestRunEvaluation" role="alert">
        <div className="evaluationSectionHead"><span>01</span><div><h2>최근 실행 성능 진단</h2><p>{state.runId ?? "요청한 실행"}을 조회하지 못했습니다.</p></div></div>
        <p className="evaluationClaim"><strong>조회 실패</strong> · {state.message}</p>
      </article>
    );
  }

  if (state.kind === "pending") {
    const { progress } = state.snapshot;
    return (
      <article id="latest-run-evaluation" className="latestRunEvaluation" aria-live="polite">
        <div className="evaluationSectionHead"><span>01</span><div><h2>최근 실행 성능 진단</h2><p>{state.runId} 실행이 아직 완료되지 않았습니다. 완료될 때까지 자동으로 갱신합니다.</p></div></div>
        <p className="evaluationClaim">
          <strong>{state.snapshot.status ?? "진행 중"}</strong> · 완료 {progress?.terminalCount ?? 0}/{progress?.totalCount ?? 0} · 남은 작업 {progress?.remainingCount ?? 0}
        </p>
      </article>
    );
  }

  const { result, snapshot } = state;
  const metrics = result.metrics ?? {};
  const privacy = metrics.privacyRisk ?? null;
  const provenance = metrics.provenance?.fields ?? {};
  const routing = result.routerDecision;
  const selection = routing?.primarySelection;
  const evidencePlan = result.evidencePlan;
  const completedAt = finite(snapshot.completedAt)
    ? new Date(snapshot.completedAt).toLocaleString("ko-KR")
    : "—";

  return (
    <article id="latest-run-evaluation" className="latestRunEvaluation" data-run-id={state.runId}>
      <div className="evaluationSectionHead">
        <span>01</span>
        <div>
          <h2>최근 실행 성능 진단</h2>
          <p>응답 내용과 분리한 단일 실행의 Privacy, 품질, 인용, 라우팅 및 스케줄러 측정값입니다. 값이 없는 항목은 추정하지 않고 —로 표시합니다.</p>
        </div>
      </div>

      <div className="evaluationSummary latestRunSummary">
        <div><span>RUN</span><strong>{state.runId}</strong><small>{completedAt}</small></div>
        <div><span>MODE</span><strong>{modeLabels[result.mode ?? snapshot.mode ?? ""] ?? result.mode ?? snapshot.mode ?? "—"}</strong><small>{result.execution?.executionStatus ?? snapshot.status ?? "—"}</small></div>
        <div><span>MODEL</span><strong>{metrics.model ?? result.integration?.model ?? "—"}</strong><small>{metrics.llmBackend ?? result.integration?.backend ?? "—"}</small></div>
        <div><span>QUALITY</span><strong>{score(metrics.qualityScore)}</strong><small>실행 결과 기반 산출값</small></div>
      </div>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-privacy-title">
        <h3 id="latest-privacy-title">Privacy Risk v2</h3>
        <div className="methodGrid latestRunMetricGrid">
          <MetricCard label="Privacy Risk" value={score(privacy?.score ?? metrics.privacyRiskScore)} provenance={provenance.privacyRiskScore} />
          <MetricCard label="S · 민감정보 전달" value={ratio(privacy?.sensitiveTransmissionRatio)} detail={finite(privacy?.sensitiveTransmittedCount) && finite(privacy?.sensitiveDetectedCount) ? `${privacy.sensitiveTransmittedCount}/${privacy.sensitiveDetectedCount}건` : "—"} provenance={provenance.sensitiveTransmissionRatio} />
          <MetricCard label="A · Agent 선택" value={ratio(privacy?.agentSelectionRatio)} detail={finite(privacy?.selectedAgentCount) && finite(privacy?.totalAgentCount) ? `${privacy.selectedAgentCount}/${privacy.totalAgentCount} Agent` : "—"} provenance={provenance.agentSelectionRatio} />
          <MetricCard label="O · 원문 전달" value={ratio(privacy?.originalDisclosureRatio)} detail={finite(privacy?.transmittedOriginalBytes) && finite(privacy?.originalBytes) ? `${privacy.transmittedOriginalBytes}/${privacy.originalBytes}B` : "—"} provenance={provenance.originalDisclosureRatio} />
          <MetricCard label="Privacy pass" value={booleanLabel(privacy?.privacyPass, "통과", "검토 필요")} />
          <MetricCard label="Output leak" value={booleanLabel(privacy?.outputLeak, "감지", "없음")} />
          <MetricCard label="원문 Edge 이탈" value={booleanLabel(metrics.rawDataLeavesEdge, "발생", "없음")} provenance={provenance.rawDataLeavesEdge} />
          <MetricCard label="수신 주체" value={integer(privacy?.recipientCount ?? metrics.dataRecipients)} detail={finite(privacy?.egressEnvelopeCount) ? `egress envelope ${privacy.egressEnvelopeCount}개` : "—"} />
        </div>
      </section>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-quality-title">
        <h3 id="latest-quality-title">응답 품질 및 RAG 인용</h3>
        <div className="methodGrid latestRunMetricGrid">
          <MetricCard label="종합 품질" value={score(metrics.qualityScore)} />
          <MetricCard label="근거 기반성" value={score(metrics.groundedness)} />
          <MetricCard label="질의 관련성" value={score(metrics.relevance)} />
          <MetricCard label="근거 지지율" value={score(metrics.evidenceSupport)} />
          <MetricCard label="인용 Coverage" value={score(metrics.citationCoverage)} />
          <MetricCard label="인용 Validity" value={score(metrics.citationValidity)} />
          <MetricCard label="인용 Recall" value={score(metrics.citationRecall)} />
          <MetricCard label="Claim support" value={score(metrics.claimSupportRate)} />
          <MetricCard label="검색 성공률" value={score(metrics.retrievalSuccessRate)} />
          <MetricCard label="근거 활용률" value={score(metrics.evidenceUtilizationRate)} />
          <MetricCard label="도메인 Coverage" value={score(metrics.domainCoverage)} />
          <MetricCard label="응답 완결성" value={score(metrics.answerCompleteness)} detail={finite(metrics.ragChunks) ? `RAG chunk ${metrics.ragChunks}개` : "—"} />
        </div>
      </section>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-runtime-title">
        <h3 id="latest-runtime-title">실행 비용·지연·경계</h3>
        <div className="methodGrid latestRunMetricGrid">
          <MetricCard label="LLM 호출" value={integer(metrics.calls, "회")} detail={finite(metrics.agentCalls) && finite(metrics.integrationCalls) ? `Agent ${metrics.agentCalls} · 통합 ${metrics.integrationCalls}` : "—"} provenance={provenance.calls} />
          <MetricCard label="총 Token" value={integer(metrics.tokens)} detail={metrics.tokenBreakdown && finite(metrics.tokenBreakdown.promptTokens) && finite(metrics.tokenBreakdown.completionTokens) ? `prompt ${metrics.tokenBreakdown.promptTokens} · completion ${metrics.tokenBreakdown.completionTokens}` : "—"} provenance={provenance.tokens} />
          <MetricCard label="E2E" value={milliseconds(metrics.latencyMs)} provenance={provenance.latencyMs} />
          <MetricCard label="Queue wait" value={milliseconds(metrics.latencyBreakdown?.queueWaitMs)} provenance={provenance.queueWaitMs} />
          <MetricCard label="Inference" value={milliseconds(metrics.latencyBreakdown?.inferenceMs)} provenance={provenance.inferenceMs} />
          <MetricCard label="Boundary payload" value={bytes(metrics.boundaryBytes)} provenance={provenance.boundaryBytes} />
          <MetricCard label="TTFT" value={milliseconds(metrics.ttftMs)} />
          <MetricCard label="TPOT" value={milliseconds(metrics.tpotMs)} />
          <MetricCard label="Scheduler policy" value={result.execution?.scheduling?.policy ?? "—"} detail={finite(result.execution?.scheduling?.scheduledTaskCount) ? `${result.execution?.scheduling?.scheduledTaskCount}개 작업` : "—"} />
          <MetricCard label="최소화율" value={normalizedPercent(metrics.minimizationRate)} />
        </div>
      </section>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-routing-title">
        <h3 id="latest-routing-title">라우팅 판단</h3>
        <div className="methodGrid latestRunRoutingSummary">
          <MetricCard label="주관 Agent" value={routing?.primaryAgent ?? "—"} detail={routing?.selected?.length ? `선택 ${routing.selected.join(", ")}` : "—"} />
          <MetricCard label="예측 Coverage" value={normalizedPercent(routing?.predictedCoverage)} />
          <MetricCard label="선택 신뢰도" value={normalizedPercent(selection?.confidence)} detail={selection?.algorithm ?? "—"} />
          <MetricCard label="Top1–Top2 margin" value={normalizedPercent(selection?.top1Top2Margin)} />
          <MetricCard label="목적함수 비용" value={decimal(routing?.objectiveCost, 3)} />
          <MetricCard label="Human review" value={booleanLabel(routing?.humanReviewRequired, "필요", "불필요")} />
          <MetricCard label="Fallback" value={booleanLabel(selection?.fallbackUsed, "사용", "미사용")} detail={selection?.fallbackReason ?? "—"} />
        </div>
        {selection?.rankedCandidates?.length ? (
          <ol className="limitations latestRunRoutingCandidates">
            {selection.rankedCandidates.map((candidate, index) => (
              <li key={`${candidate.agentId ?? "agent"}-${candidate.rank ?? index}`}>
                <strong>{candidate.rank ?? index + 1}위 · {candidate.agentId ?? "—"}</strong>
                <span>
                  총점 {decimal(candidate.totalScore, 3)} · 일치 단어 {candidate.matchedTerms?.join(", ") || "—"} · 개념 {candidate.matchedConceptIds?.join(", ") || "—"}
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="evaluationClaim">라우팅 후보 점수 —</p>}
      </section>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-evidence-plan-title">
        <h3 id="latest-evidence-plan-title">RAG 근거 충족 진단</h3>
        <div className="methodGrid latestRunRoutingSummary">
          <MetricCard label="근거 Coverage" value={normalizedPercent(evidencePlan?.coverage)} />
          <MetricCard label="충족 개념" value={integer(evidencePlan?.coveredConceptIds?.length)} detail={evidencePlan?.coveredConceptIds?.join(", ") || "—"} />
          <MetricCard label="미충족 개념" value={integer(evidencePlan?.missingConceptIds?.length)} detail={evidencePlan?.missingConceptIds?.join(", ") || "없음"} />
          <MetricCard label="근거 Human review" value={booleanLabel(evidencePlan?.humanReviewRequired, "필요", "불필요")} />
        </div>
        {evidencePlan?.agentPlans?.length ? (
          <ul className="limitations latestRunEvidencePlans">
            {evidencePlan.agentPlans.map((plan, index) => {
              const transferredBytes = plan.transfers?.reduce(
                (sum, transfer) => sum + (finite(transfer.egressBytes) ? transfer.egressBytes : 0),
                0,
              );
              return (
                <li key={`${plan.agentId ?? "agent"}-${index}`}>
                  <strong>{plan.agentId ?? "—"} · {plan.status ?? "—"}</strong>
                  <span>
                    Coverage {normalizedPercent(plan.coverage)} · 공개 방식 {plan.modes?.join(", ") || "—"} · 근거 전송 {bytes(transferredBytes)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="evaluationClaim">Agent별 근거 충족 진단 —</p>}
      </section>

      {result.commercialJudge?.enabled ? (
        <section className="latestRunDiagnosticSection" aria-labelledby="latest-judge-title">
          <h3 id="latest-judge-title">상용 LLM 블라인드 평가</h3>
          <div className="methodGrid latestRunJudgeMetrics">
            <MetricCard label="Correctness" value={score(result.commercialJudge.correctness)} />
            <MetricCard label="Groundedness" value={score(result.commercialJudge.groundedness)} />
            <MetricCard label="Completeness" value={score(result.commercialJudge.completeness)} />
            <MetricCard label="Overall" value={score(result.commercialJudge.overall)} detail={[result.commercialJudge.provider, result.commercialJudge.model].filter(Boolean).join(" · ") || "—"} />
          </div>
          {result.commercialJudge.error ? <p className="evaluationClaim">Judge 오류 · {result.commercialJudge.error}</p> : null}
        </section>
      ) : null}

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-checks-title">
        <h3 id="latest-checks-title">검증 체크</h3>
        {result.checks?.length ? (
          <ul className="limitations latestRunChecks">
            {result.checks.map((check, index) => (
              <li key={`${check.label ?? "check"}-${index}`}>
                <strong>{check.status === "pass" ? "통과" : "검토"} · {check.label ?? "—"}</strong>
                <span>{check.detail ?? "—"}</span>
              </li>
            ))}
          </ul>
        ) : <p className="evaluationClaim">검증 체크 —</p>}
      </section>

      <section className="latestRunDiagnosticSection" aria-labelledby="latest-timeline-title">
        <h3 id="latest-timeline-title">스케줄러 타임라인</h3>
        {result.timeline?.length ? (
          <ol className="compactTimeline latestRunTimeline">
            {result.timeline.map((item, index) => (
              <li key={`${item.label ?? "timeline"}-${index}`}>
                <b>{index + 1}</b>
                <span><strong>{item.label ?? "—"}</strong><small>{item.detail ?? "—"} · Queue {milliseconds(item.queueWaitMs)} · Inference {milliseconds(item.inferenceMs)}</small></span>
                <em>{milliseconds(item.ms)}</em>
              </li>
            ))}
          </ol>
        ) : <p className="evaluationClaim">스케줄러 타임라인 —</p>}
      </section>
    </article>
  );
}
