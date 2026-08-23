import Link from "next/link";
import type { ReactNode } from "react";

import expandedReportJson from "../../data/evaluation/expanded-report-v2.json";
import offlineReportJson from "../../data/evaluation/latest-report-v2.json";
import repeatReportJson from "../../data/evaluation/repeat-benchmark-report-v2.json";
import LatestRunEvaluation from "./LatestRunEvaluation";

const REPORT_SCHEMA_VERSION = "mnc-privacy-evaluation/v2";
const PRIVACY_RISK_VERSION = "v2";

type ReportStatus = "measured" | "partial" | "pending-replay";

type PrivacyAggregate = {
  privacyRiskVersion: "v2";
  status: "measured";
  sampleSize: number;
  averageScore: number;
  sensitiveTransmission: {
    averageNumerator: number;
    averageDenominator: number;
    averageRatio: number;
  };
  agentSelection: {
    averageNumerator: number;
    averageDenominator: number;
    averageRatio: number;
  };
  originalDisclosure: {
    averageNumeratorBytes: number;
    averageDenominatorBytes: number;
    averageRatio: number;
  };
  exposureStates: {
    sensitiveNotDetected: number;
    detectedFullyMasked: number;
    sensitiveExposure: number;
  };
  privacyPassRate: number;
  outputLeakRate: number;
};

type VersionedReport = {
  schemaVersion: string;
  privacyRiskVersion: string;
  status: ReportStatus;
  generatedAt: string | null;
  expectedRuns?: number;
  completedRuns?: number;
  runs?: number;
  pendingReason?: string;
};

type OfflineModeSummary = {
  quality: number;
  conceptRecall: number;
  agentSelectionF1: number;
  retrievalSuccessRate: number;
  citationValidity: number;
  forbiddenOutputPassRate: number;
  averageBoundaryBytes: number;
  averagePrivacyRiskScore: number;
  averageLatencyMs: number | null;
  qualityRetention: number | null;
  privacyRisk: PrivacyAggregate;
};

type OfflineReport = VersionedReport & {
  cases: number;
  modes: Record<string, OfflineModeSummary>;
};

type ExpandedModeSummary = {
  n: number;
  objectiveQuality: number;
  objectiveQualityCi95: [number, number];
  agentMacroF1: number;
  agentMicroPrecision: number;
  agentMicroRecall: number;
  agentMicroF1: number;
  requiredConceptRecall: number;
  retrievalRecallAtK: number;
  retrievalMrr: number;
  citationValidity: number;
  forbiddenOutputPassRate: number;
  averageBoundaryBytes: number;
  rawDataLeavesEdge: boolean;
  averagePrivacyRiskScore: number;
  qualityRetention: number | null;
  privacyRisk: PrivacyAggregate;
};

type ExpandedReport = VersionedReport & {
  cases: number;
  summaries: Record<string, ExpandedModeSummary>;
};

type RepeatModeSummary = {
  mode: string;
  n: number;
  overallMean: number | null;
  overallSd: number | null;
  correctness: number | null;
  groundedness: number | null;
  completeness: number | null;
  ttftMs: number | null;
  tpotMs: number | null;
  latencyMs: number | null;
  boundaryBytes: number | null;
  rawDataLeavesEdge: boolean | null;
  averagePrivacyRiskScore: number;
  qualityRetentionPct: number | null;
  privacyRisk: PrivacyAggregate;
};

type RepeatReport = VersionedReport & {
  repetitions: number;
  queries: number;
  completedJudgeRuns: number;
  summary: RepeatModeSummary[];
};

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

function assertV2Report(value: unknown, label: string): asserts value is VersionedReport {
  if (!isRecord(value)) throw new Error(`${label}: 보고서가 객체가 아닙니다.`);
  if (value.schemaVersion !== REPORT_SCHEMA_VERSION || value.privacyRiskVersion !== PRIVACY_RISK_VERSION) {
    throw new Error(
      `${label}: v1/v2 평가 결과를 함께 표시하거나 집계할 수 없습니다. ` +
      `${REPORT_SCHEMA_VERSION}/${PRIVACY_RISK_VERSION} 보고서가 필요합니다.`,
    );
  }
}

function assertAggregateV2(value: PrivacyAggregate, label: string) {
  if (value?.privacyRiskVersion !== PRIVACY_RISK_VERSION) {
    throw new Error(`${label}: v2가 아닌 Privacy Risk breakdown은 집계에서 제외해야 합니다.`);
  }
}

for (const [label, report] of [
  ["오프라인 파일럿", offlineReportJson],
  ["40문항 평가", expandedReportJson],
  ["반복 벤치마크", repeatReportJson],
] as const) {
  assertV2Report(report, label);
}

const offlineReport = offlineReportJson as unknown as OfflineReport;
const expandedReport = expandedReportJson as unknown as ExpandedReport;
const repeatReport = repeatReportJson as unknown as RepeatReport;

const offlineEntries = Object.entries(offlineReport.modes);
const expandedEntries = Object.entries(expandedReport.summaries);
const repeatEntries = repeatReport.summary;

for (const [mode, summary] of offlineEntries) {
  assertAggregateV2(summary.privacyRisk, `오프라인/${mode}`);
}
for (const [mode, summary] of expandedEntries) {
  assertAggregateV2(summary.privacyRisk, `40문항/${mode}`);
}
for (const summary of repeatEntries) {
  assertAggregateV2(summary.privacyRisk, `반복/${summary.mode}`);
}

function statusLabel(status: ReportStatus) {
  if (status === "measured") return "측정 완료";
  if (status === "partial") return "부분 측정";
  return "재실행 대기";
}

function reportRunCount(report: VersionedReport) {
  return report.runs ?? report.completedRuns ?? 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percent(ratio: number) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function score(value: unknown) {
  return finite(value) ? value.toFixed(1) : "—";
}

function percentScore(value: unknown) {
  return finite(value) ? `${value.toFixed(1)}%` : "—";
}

function decimal(value: unknown, suffix = "", digits = 1) {
  return finite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function bytes(value: unknown) {
  return finite(value) ? `${Math.round(value).toLocaleString()}B` : "—";
}

function yesNo(value: unknown, trueLabel = "예", falseLabel = "아니오") {
  return typeof value === "boolean" ? (value ? trueLabel : falseLabel) : "—";
}

function countRatio(ratio: number, numerator: number, denominator: number) {
  return `${percent(ratio)} · ${numerator.toFixed(1)}/${denominator.toFixed(1)}`;
}

function byteRatio(ratio: number, numerator: number, denominator: number) {
  return `${percent(ratio)} · ${Math.round(numerator).toLocaleString()}/${Math.round(denominator).toLocaleString()}B`;
}

function exposureLabel(privacy: PrivacyAggregate) {
  const { sensitiveNotDetected, detectedFullyMasked, sensitiveExposure } = privacy.exposureStates;
  if (sensitiveExposure > 0) return `일부 노출 ${sensitiveExposure}/${privacy.sampleSize}`;
  if (detectedFullyMasked > 0 && sensitiveNotDetected === 0) return "탐지 후 완전 마스킹";
  if (sensitiveNotDetected > 0 && detectedFullyMasked === 0) return "민감정보 미탐지";
  return `미탐지 ${sensitiveNotDetected} · 완전 마스킹 ${detectedFullyMasked}`;
}

function PendingReport({ report }: { report: VersionedReport }) {
  return (
    <p className="evaluationClaim">
      <strong>{statusLabel(report.status)}</strong> · 완료 {reportRunCount(report).toLocaleString()}회 /
      예정 {(report.expectedRuns ?? 0).toLocaleString()}회 · {report.pendingReason ?? "일부 측정값이 아직 없습니다."}
      미측정 값은 추정값으로 채우지 않고 <b>—</b>로 표시합니다.
    </p>
  );
}

function TableHeader({ children }: { children: ReactNode }) {
  return <div className="evaluationTableHead">{children}</div>;
}

export default function EvaluationPage() {
  return (
    <main className="aboutPage evaluationPage">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brandMark">M</span>
          <div><strong>MNC FLOW</strong><small>KOREN Distributed AI Governance</small></div>
        </Link>
        <nav className="navLinks" aria-label="주요 페이지">
          <Link className="aboutLink" href="/about">서비스 소개</Link>
          <Link className="aboutLink" href="/">실행 화면</Link>
        </nav>
      </header>

      <section className="aboutHero evaluationHero">
        <span className="eyebrow">VERSIONED PERFORMANCE EVALUATION</span>
        <h1>응답과 성능 진단을 분리하고,<br />측정된 값만 보여줍니다.</h1>
        <p>
          개별 실행의 Privacy·품질·라우팅·스케줄러 지표와 재현 가능한 고정 평가 결과를 한곳에서 확인합니다.
          정적 비교표는 versioned report JSON을 사용하며, 버전이 없거나 아직 측정되지 않은 값은 집계하지 않습니다.
        </p>
        <div className="evaluationSummary">
          <div><span>PRIVACY SCHEMA</span><strong>v2</strong><small>S/A/O breakdown</small></div>
          <div><span>파일럿</span><strong>{reportRunCount(offlineReport)}</strong><small>{statusLabel(offlineReport.status)}</small></div>
          <div><span>40문항 평가</span><strong>{reportRunCount(expandedReport) || "—"}</strong><small>{statusLabel(expandedReport.status)}</small></div>
          <div><span>반복 평가</span><strong>{reportRunCount(repeatReport) || "—"}</strong><small>{statusLabel(repeatReport.status)}</small></div>
        </div>
      </section>

      <section className="evaluationBody">
        <LatestRunEvaluation />

        <article>
          <div className="evaluationSectionHead">
            <span>02</span>
            <div>
              <h2>파일럿 모드별 평가</h2>
              <p>Privacy Risk v2의 S/A/O breakdown과 기존 JSON에 기록된 품질·인용·출력보호·지연·경계 전송량을 함께 표시합니다.</p>
            </div>
          </div>
          {offlineReport.status === "measured" && offlineEntries.length > 0 ? (
            <>
              <h3 className="evaluationSubheading">Privacy Risk v2</h3>
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="offline-privacy-table">
                  <TableHeader>
                    <span>방식</span><span>Risk</span><span>S 민감정보</span><span>A Agent</span>
                    <span>O 원문</span><span>노출 상태</span><span>Privacy pass</span><span>표본</span>
                  </TableHeader>
                  {offlineEntries.map(([mode, summary]) => (
                    <div key={mode} className={mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[mode] ?? mode}</strong>
                      <span>{score(summary.averagePrivacyRiskScore)}</span>
                      <span>{countRatio(summary.privacyRisk.sensitiveTransmission.averageRatio, summary.privacyRisk.sensitiveTransmission.averageNumerator, summary.privacyRisk.sensitiveTransmission.averageDenominator)}</span>
                      <span>{countRatio(summary.privacyRisk.agentSelection.averageRatio, summary.privacyRisk.agentSelection.averageNumerator, summary.privacyRisk.agentSelection.averageDenominator)}</span>
                      <span>{byteRatio(summary.privacyRisk.originalDisclosure.averageRatio, summary.privacyRisk.originalDisclosure.averageNumeratorBytes, summary.privacyRisk.originalDisclosure.averageDenominatorBytes)}</span>
                      <b className={summary.privacyRisk.exposureStates.sensitiveExposure > 0 ? "riskValue" : "safeValue"}>{exposureLabel(summary.privacyRisk)}</b>
                      <span>{percentScore(summary.privacyRisk.privacyPassRate)}</span>
                      <span>{summary.privacyRisk.sampleSize}</span>
                    </div>
                  ))}
                </div>
              </div>

              <h3 className="evaluationSubheading">품질·인용·출력보호·운영 성능</h3>
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="offline-performance-table">
                  <TableHeader>
                    <span>방식</span><span>객관 품질</span><span>Agent F1</span><span>검색 성공률</span>
                    <span>인용 유효성</span><span>출력보호 통과</span><span>Latency</span><span>Boundary bytes</span>
                  </TableHeader>
                  {offlineEntries.map(([mode, summary]) => (
                    <div key={mode} className={mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[mode] ?? mode}</strong>
                      <span>{score(summary.quality)}</span>
                      <span>{score(summary.agentSelectionF1)}</span>
                      <span>{percentScore(summary.retrievalSuccessRate)}</span>
                      <span>{percentScore(summary.citationValidity)}</span>
                      <span>{percentScore(summary.forbiddenOutputPassRate)}</span>
                      <span>{decimal(summary.averageLatencyMs, "ms")}</span>
                      <span>{bytes(summary.averageBoundaryBytes)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : <PendingReport report={offlineReport} />}
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>03</span>
            <div>
              <h2>40문항 × 5모드 고정 정답 평가</h2>
              <p>총 200회 평가의 품질, Agent 선택, 문서 검색, 인용, 출력보호 및 경계 전송량을 같은 v2 계약으로 비교합니다.</p>
            </div>
          </div>
          {expandedReport.status === "measured" && expandedEntries.length > 0 ? (
            <>
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="expanded-quality-table">
                  <TableHeader>
                    <span>방식</span><span>객관 품질</span><span>95% CI</span><span>Agent F1</span>
                    <span>개념 Recall</span><span>문서 Recall@K</span><span>Privacy Risk</span><span>노출 상태</span>
                  </TableHeader>
                  {expandedEntries.map(([mode, summary]) => (
                    <div key={mode} className={mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[mode] ?? mode}</strong>
                      <span>{score(summary.objectiveQuality)}</span>
                      <span>{summary.objectiveQualityCi95.map((value) => value.toFixed(1)).join("–")}</span>
                      <span>{score(summary.agentMacroF1)}</span>
                      <span>{score(summary.requiredConceptRecall)}</span>
                      <span>{score(summary.retrievalRecallAtK)}</span>
                      <span>{score(summary.averagePrivacyRiskScore)}</span>
                      <b className={summary.privacyRisk.exposureStates.sensitiveExposure > 0 ? "riskValue" : "safeValue"}>{exposureLabel(summary.privacyRisk)}</b>
                    </div>
                  ))}
                </div>
              </div>

              <h3 className="evaluationSubheading">인용·출력보호·경계 보조 지표</h3>
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="expanded-safety-table">
                  <TableHeader>
                    <span>방식</span><span>인용 유효성</span><span>출력보호 통과</span><span>Boundary bytes</span>
                    <span>원문 Edge 이탈</span><span>검색 MRR</span><span>품질 유지율</span><span>표본</span>
                  </TableHeader>
                  {expandedEntries.map(([mode, summary]) => (
                    <div key={mode} className={mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[mode] ?? mode}</strong>
                      <span>{percentScore(summary.citationValidity)}</span>
                      <span>{percentScore(summary.forbiddenOutputPassRate)}</span>
                      <span>{bytes(summary.averageBoundaryBytes)}</span>
                      <span>{yesNo(summary.rawDataLeavesEdge, "이탈", "없음")}</span>
                      <span>{score(summary.retrievalMrr)}</span>
                      <span>{percentScore(summary.qualityRetention)}</span>
                      <span>{summary.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : <PendingReport report={expandedReport} />}
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>04</span>
            <div>
              <h2>적용 안정성 반복 벤치마크</h2>
              <p>5질의 × 5모드 × 3회 실행의 품질 Judge, TTFT/TPOT, E2E 지연, 경계 전송량 및 Privacy 지표입니다.</p>
            </div>
          </div>
          {repeatEntries.length > 0 && repeatReport.status !== "pending-replay" ? (
            <>
              {repeatReport.status === "partial" ? <PendingReport report={repeatReport} /> : null}
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="repeat-overview-table">
                  <TableHeader>
                    <span>방식</span><span>종합 품질</span><span>표준편차</span><span>Latency</span>
                    <span>Boundary bytes</span><span>Privacy Risk</span><span>노출 상태</span><span>표본</span>
                  </TableHeader>
                  {repeatEntries.map((summary) => (
                    <div key={summary.mode} className={summary.mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[summary.mode] ?? summary.mode}</strong>
                      <span>{score(summary.overallMean)}</span>
                      <span>{score(summary.overallSd)}</span>
                      <span>{decimal(summary.latencyMs, "ms")}</span>
                      <span>{bytes(summary.boundaryBytes)}</span>
                      <span>{score(summary.averagePrivacyRiskScore)}</span>
                      <b className={summary.privacyRisk.exposureStates.sensitiveExposure > 0 ? "riskValue" : "safeValue"}>{exposureLabel(summary.privacyRisk)}</b>
                      <span>{summary.n}</span>
                    </div>
                  ))}
                </div>
              </div>

              <h3 className="evaluationSubheading">Judge·생성 지연 상세</h3>
              <div className="evaluationTableWrap">
                <div className="evaluationTable" data-testid="repeat-detail-table">
                  <TableHeader>
                    <span>방식</span><span>Correctness</span><span>Groundedness</span><span>Completeness</span>
                    <span>TTFT</span><span>TPOT</span><span>원문 Edge 이탈</span><span>품질 유지율</span>
                  </TableHeader>
                  {repeatEntries.map((summary) => (
                    <div key={summary.mode} className={summary.mode === "proposed" ? "evaluationHighlight" : ""}>
                      <strong>{modeLabels[summary.mode] ?? summary.mode}</strong>
                      <span>{score(summary.correctness)}</span>
                      <span>{score(summary.groundedness)}</span>
                      <span>{score(summary.completeness)}</span>
                      <span>{decimal(summary.ttftMs, "ms")}</span>
                      <span>{decimal(summary.tpotMs, "ms")}</span>
                      <span>{yesNo(summary.rawDataLeavesEdge, "이탈", "없음")}</span>
                      <span>{percentScore(summary.qualityRetentionPct)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : <PendingReport report={repeatReport} />}
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>05</span>
            <div>
              <h2>계산 기준과 스키마 보호</h2>
              <p>보고서 생성 단계와 페이지 로딩 단계에서 Privacy 버전을 검증하고, 측정값과 미측정값을 구분합니다.</p>
            </div>
          </div>
          <div className="methodGrid">
            <div><b>Privacy Risk v2</b><code>100 × (0.5 × S + 0.3 × A + 0.2 × O)</code></div>
            <div><b>S · 민감정보 전달 비율</b><p>탐지된 민감정보 중 경계를 넘어 전달된 민감정보의 비율입니다.</p></div>
            <div><b>A · Agent 선택 비율</b><p>등록된 전체 Agent 중 요청 처리에 선택된 Agent의 비율입니다.</p></div>
            <div><b>O · 원문 전달 비율</b><p>보호 대상 원문 byte 중 외부 실행 경계로 전달된 원문 byte의 비율입니다.</p></div>
            <div><b>출력보호</b><p>금지된 민감 필드가 최종 출력에 포함되지 않았는지 고정 규칙으로 검사합니다.</p></div>
            <div><b>Schema guard</b><p>버전이 없거나 v2가 아닌 보고서는 평균 계산 전에 오류로 중단합니다.</p></div>
          </div>
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>06</span>
            <div><h2>현재 해석 범위</h2><p>완료된 실행과 아직 검증 중인 지표를 구분합니다.</p></div>
          </div>
          <ul className="limitations">
            <li><strong>표시 원칙</strong><span>미실행 모드의 점수·감소율·순위를 추정하지 않고 해당 값을 —로 표시합니다.</span></li>
            <li><strong>Legacy 제외</strong><span>버전 없는 latest-report.json, expanded-report.json, literature-baseline-report.json은 v2 평균에 포함하지 않습니다.</span></li>
            <li><strong>단일 실행</strong><span>최근 실행 진단은 해당 RUN-ID의 측정값이며 모드 간 우월성을 의미하지 않습니다.</span></li>
            <li><strong>고정 평가</strong><span>40문항 평가는 저자 라벨 고정 데이터셋이며 독립적인 held-out 평가가 아닙니다.</span></li>
            <li><strong>부분 Judge</strong><span>상용 Judge가 구성되지 않은 반복 평가의 품질 값은 추정하지 않고 —로 남깁니다.</span></li>
          </ul>
        </article>
      </section>

      <footer>
        <span>MNC Lab. · Korea University</span>
        <div className="footerLinks"><Link href="/about">서비스 소개</Link><Link href="/">MNC FLOW 실행 화면</Link></div>
      </footer>
    </main>
  );
}
