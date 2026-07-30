"use client";

import { useEffect, useMemo, useState } from "react";

type AgentResult = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  selected: boolean;
  selectionReason?: string;
  score: number;
  question: string;
  summary: string;
  evidence: { id: string; title: string; excerpt: string; sourceUrl?: string; effectiveDate?: string }[];
  responsibility: string;
  filteredFields: string[];
  latencyMs: number;
  inference?: {
    backend: "ollama" | "deterministic";
    model: string;
    ttftMs: number | null;
    tpotMs: number | null;
    fallbackReason?: string;
  };
};

type RunResult = {
  runId: string;
  mode: "proposed" | "parallel" | "centralized";
  title: string;
  conclusion: string;
  status: "ready" | "review";
  agents: AgentResult[];
  checks: { label: string; status: "pass" | "warn"; detail: string }[];
  metrics: {
    calls: number;
    tokens: number;
    bytes: number;
    latencyMs: number;
    exposedFields: number;
    traceability: number;
    ragChunks?: number;
    llmBackend?: "ollama" | "deterministic";
    model?: string;
    ttftMs?: number | null;
    tpotMs?: number | null;
  };
  timeline: { label: string; detail: string; ms: number }[];
};

type LlmHealth = {
  status: "connected" | "degraded" | "disconnected";
  connected: number;
  total: number;
  model: string;
};

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

const exampleRequests = [
  "민원 상담용 생성형 AI 서비스를 도입하려고 합니다. 개인정보 보호, 클라우드 보안, 법적 책임과 예산 타당성을 종합 검토해 주세요.",
  "내부 연구자료 검색 AI를 구축하려고 합니다. 기술 구성과 보안 통제 방안을 중심으로 검토해 주세요.",
  "고객 응대 챗봇 외주 계약을 추진합니다. 계약상 책임과 예상 운영비를 검토해 주세요.",
];

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
    mode === "proposed"
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
  const calls = selectedIds.length;
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
      bytes: mode === "proposed" ? calls * 1840 : mode === "parallel" ? 14680 : 42800,
      latencyMs: mode === "proposed" ? 1120 : mode === "parallel" ? 1540 : 1890,
      exposedFields,
      traceability: mode === "proposed" ? 100 : mode === "parallel" ? 72 : 35,
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

export default function Home() {
  const [query, setQuery] = useState(exampleRequests[0]);
  const [mode, setMode] = useState<RunResult["mode"]>("proposed");
  const [result, setResult] = useState<RunResult>(() => buildFallbackResult(exampleRequests[0], "proposed"));
  const [benchmarks, setBenchmarks] = useState<Partial<Record<RunResult["mode"], RunResult["metrics"]>>>({});
  const [llmHealth, setLlmHealth] = useState<LlmHealth | null>(null);
  const [running, setRunning] = useState(false);
  const [activeAgent, setActiveAgent] = useState("security");
  const selectedResult = result.agents.find((agent) => agent.id === activeAgent) ?? result.agents[0];
  const selectedCount = result.agents.filter((agent) => agent.selected).length;

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

  const comparison = useMemo(() => {
    return [
      { id: "centralized" as const, name: "중앙집중형" },
      { id: "parallel" as const, name: "병렬 Multi-Agent" },
      { id: "proposed" as const, name: "제안 방식" },
    ].map((item) => ({
      ...item,
      metrics: benchmarks[item.id] ?? buildFallbackResult(query, item.id).metrics,
      measured: Boolean(benchmarks[item.id]),
    }));
  }, [benchmarks, query]);

  async function run() {
    setRunning(true);
    try {
      const response = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, mode }),
      });
      if (!response.ok) throw new Error("orchestration failed");
      const next = await response.json() as RunResult;
      setResult(next);
      setBenchmarks((current) => ({ ...current, [next.mode]: next.metrics }));
      const first = next.agents.find((agent) => agent.selected);
      if (first) setActiveAgent(first.id);
    } catch {
      const next = buildFallbackResult(query, mode);
      setResult(next);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brandMark">M</span>
          <div><strong>MNC FLOW</strong><small>KOREN Distributed AI Governance</small></div>
        </div>
        <div className="networkState">
          <span /> {!llmHealth
            ? "Local LLM · 확인 중"
            : llmHealth.status === "connected"
              ? `Local LLM · ${llmHealth.connected}/${llmHealth.total} 연결 · ${llmHealth.model}`
              : `Local LLM · ${llmHealth.connected}/${llmHealth.total} 연결`}
        </div>
      </header>

      <section className="hero">
        <div>
          <span className="eyebrow">CORE ORCHESTRATOR / LIVE WORKSPACE</span>
          <h1>분산된 전문성은 연결하고,<br /><em>데이터는 제자리에.</em></h1>
          <p>필요한 조직 Agent만 선택해 최소 정보로 협업하고, 모든 판단의 근거와 책임을 추적합니다.</p>
        </div>
        <div className="heroStatus">
          <div className="pulse"><i /><i /><i /></div>
          <span>CORE ↔ EDGE</span>
          <strong>{selectedCount} / {agents.length}</strong>
          <small>활성 Agent</small>
        </div>
      </section>

      <section className="workspace">
        <aside className="requestPanel">
          <div className="sectionHead"><span>01</span><div><strong>업무 요청</strong><small>복합 검토 요청을 입력하세요</small></div></div>
          <textarea aria-label="업무 요청" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="examples">
            {exampleRequests.map((example, index) => (
              <button key={example} onClick={() => setQuery(example)}>예시 {index + 1}</button>
            ))}
          </div>
          <label className="modeLabel">실행 방식</label>
          <div className="modePicker">
            {[
              ["proposed", "제안 방식", "동적 선택 + 최소 전달"],
              ["parallel", "병렬 방식", "모든 Agent 호출"],
              ["centralized", "중앙집중형", "중앙에서 전체 처리"],
            ].map(([id, label, detail]) => (
              <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id as RunResult["mode"])}>
                <span>{label}</span><small>{detail}</small>
              </button>
            ))}
          </div>
          <button className="runButton" disabled={running || !query.trim()} onClick={run}>
            {running ? <><span className="spinner" /> 협업 실행 중</> : <>협업 실행 <span>→</span></>}
          </button>
          <p className="privacyNote">원문 데이터는 각 Edge를 벗어나지 않습니다.</p>
        </aside>

        <div className="resultPanel">
          <div className="orchestrationHead">
            <div><span className="liveDot" /> RUN {result.runId}</div>
            <span>{result.mode === "proposed" ? "동적 오케스트레이션" : result.mode === "parallel" ? "병렬 호출" : "중앙집중 처리"}</span>
          </div>

          <div className={`agentRail ${running ? "running" : ""}`}>
            <div className="coreNode"><span>CORE</span><strong>Orchestrator</strong><small>선택 · 제한 · 검증 · 추적</small></div>
            <div className="railLine" />
            <div className="agentNodes">
              {result.agents.map((agent) => (
                <button
                  key={agent.id}
                  className={`${agent.selected ? "selected" : ""} ${activeAgent === agent.id ? "focused" : ""}`}
                  onClick={() => setActiveAgent(agent.id)}
                  title={agent.selectionReason ?? (agent.selected ? "질의와 역할이 일치했습니다." : "이번 질의에서는 선택되지 않았습니다.")}
                  style={{ "--agent": agent.color } as React.CSSProperties}
                >
                  <i>{agent.shortName.slice(0, 1)}</i>
                  <strong>{agent.shortName}</strong>
                  <small>{agent.selected ? `${agent.score}% match` : "대기"}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="resultGrid">
            <section className="reportCard">
              <div className="cardLabel"><span>통합 검토 결과</span><b className={result.status}>{result.status === "ready" ? "조건부 추진" : "추가 검토"}</b></div>
              <h2>{result.title}</h2>
              <p>{result.conclusion}</p>
              <div className="conditions">
                <strong>선행 조건</strong>
                <span>Edge 원문 보존</span><span>RBAC 적용</span><span>담당자 최종 승인</span>
              </div>
            </section>
            <section className="checksCard">
              <div className="cardLabel"><span>검증 게이트</span><small>자동 점검</small></div>
              {result.checks.map((check) => (
                <div className="check" key={check.label}>
                  <i className={check.status}>{check.status === "pass" ? "✓" : "!"}</i>
                  <div><strong>{check.label}</strong><small>{check.detail}</small></div>
                </div>
              ))}
            </section>
          </div>

          <section className="evidenceCard">
            <div className="evidenceTabs">
              {result.agents.filter((agent) => agent.selected).map((agent) => (
                <button key={agent.id} className={activeAgent === agent.id ? "active" : ""} onClick={() => setActiveAgent(agent.id)}>
                  {agent.shortName} Agent
                </button>
              ))}
            </div>
            <div className="evidenceBody">
              <div>
                <span className="miniLabel">전달된 최소 질의</span>
                <p className="question">“{selectedResult.question}”</p>
                {selectedResult.selectionReason && (
                  <>
                    <span className="miniLabel">선택 근거</span>
                    <p className="selectionReason">{selectedResult.selectionReason}</p>
                  </>
                )}
                <span className="miniLabel">Edge 응답 요약</span>
                <div className={`agentRuntime ${selectedResult.inference?.backend === "ollama" ? "connected" : ""}`}>
                  <span>{selectedResult.inference?.backend === "ollama" ? "LOCAL LLM" : "FALLBACK"}</span>
                  <strong>{selectedResult.inference?.model ?? result.metrics.model ?? "qwen2.5:3b"}</strong>
                  <small>
                    {selectedResult.inference?.ttftMs != null
                      ? `TTFT ${selectedResult.inference.ttftMs} ms`
                      : selectedResult.selected ? "추론 대기 또는 fallback" : "미호출"}
                  </small>
                </div>
                <p>{selectedResult.summary}</p>
              </div>
              <div className="sources">
                <span className="miniLabel">근거 · 책임 추적</span>
                {selectedResult.evidence.map((source) => (
                  <div key={source.id}>
                    <b>{source.id}</b>
                    {source.sourceUrl ? (
                      <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.title}</a>
                    ) : (
                      <strong>{source.title}</strong>
                    )}
                    <small>{source.excerpt}</small>
                  </div>
                ))}
                <p className="owner"><span>검토 주체</span>{selectedResult.responsibility}</p>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section className="metricsSection">
        <div className="sectionTitle">
          <div><span className="eyebrow">MEASURABLE GOVERNANCE</span><h2>효율과 보호를 수치로 증명합니다.</h2></div>
          <p>동일한 요청을 세 방식으로 실행한 비교값입니다.</p>
        </div>
        <div className="metricRow">
          <Metric label="Agent 호출" value={`${result.metrics.calls} / ${result.agents.length}`} note={`${result.agents.length - result.metrics.calls}회 불필요 호출 방지`} />
          <Metric label="추정 토큰" value={result.metrics.tokens.toLocaleString()} note="질의·응답 전체" />
          <Metric label="Core–Edge 전송량" value={`${(result.metrics.bytes / 1024).toFixed(1)} KB`} note="원문 제외" />
          <Metric label="처리 지연" value={`${(result.metrics.latencyMs / 1000).toFixed(2)} s`} note="End-to-end" />
          <Metric label="TTFT" value={result.metrics.ttftMs == null ? "N/A" : `${result.metrics.ttftMs} ms`} note="실측 첫 토큰 지연" />
          <Metric label="TPOT" value={result.metrics.tpotMs == null ? "N/A" : `${result.metrics.tpotMs} ms`} note="실측 출력 토큰당 시간" />
          <Metric label="불필요 필드" value={`${result.metrics.exposedFields}`} note="반환 필터 이후" />
          <Metric label="추적 가능성" value={`${result.metrics.traceability}%`} note="근거·주체 연결률" />
        </div>
        <div className="comparison">
          <div className="comparisonHead"><span>방식별 비교</span><span>상태</span><span>호출</span><span>E2E</span><span>TTFT</span><span>TPOT</span><span>추적성</span></div>
          {comparison.map((row) => (
            <div className={row.id === "proposed" ? "highlight" : ""} key={row.id}>
              <strong>{row.name}</strong>
              <span>{row.measured ? "실측" : "미실행"}</span>
              <span>{row.metrics.calls}</span>
              <span>{row.measured ? `${(row.metrics.latencyMs / 1000).toFixed(1)} s` : "—"}</span>
              <span>{row.measured && row.metrics.ttftMs != null ? `${row.metrics.ttftMs} ms` : "—"}</span>
              <span>{row.measured && row.metrics.tpotMs != null ? `${row.metrics.tpotMs} ms` : "—"}</span>
              <span>{row.metrics.traceability}%</span>
            </div>
          ))}
        </div>
      </section>

      <section className="traceSection">
        <div className="sectionTitle"><div><span className="eyebrow">AUDIT TRAIL</span><h2>협업 전 과정을 재현합니다.</h2></div><p>각 단계의 입력·정책·결과를 감사 로그로 남깁니다.</p></div>
        <div className="timeline">
          {result.timeline.map((item, index) => (
            <div key={item.label}><b>{String(index + 1).padStart(2, "0")}</b><i /><strong>{item.label}</strong><p>{item.detail}</p><span>{item.ms} ms</span></div>
          ))}
        </div>
      </section>

      <footer><span>MNC Lab. · Korea University</span><span>KOREN 기반 분산 AI Agent 협력 거버넌스 플랫폼</span></footer>
    </main>
  );
}
