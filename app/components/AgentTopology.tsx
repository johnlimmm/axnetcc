type TopologyAgent = { id: string; shortName: string; color: string };
type TopologyState = {
  mode: string;
  core: { stage: string; kind: string };
  routerDecision?: { primaryAgent: string; required: string[] };
  agents: Record<string, { selected: boolean | null; stage: string }>;
};

export default function AgentTopology({ agents, state, stageLabel }: {
  agents: TopologyAgent[];
  state: TopologyState;
  stageLabel: (stage: string) => string;
}) {
  const activeStages = ["retrieving", "retrieved", "generating", "mapping"];
  const finishedStages = ["completed", "mapped", "fallback"];
  const selectedCount = agents.filter(agent => state.agents[agent.id]?.selected).length;
  const integrating = ["generating", "integrating", "judging"].includes(state.core.stage);
  const coreLabel = state.core.kind === "managed-supervisor" ? "Supervisor" : "Core";
  const coreStatus = state.core.stage === "completed" ? "통합 완료" : integrating ? "보고서 통합 중" : selectedCount ? "Agent 협업 진행" : "담당 Agent 분석 중";
  return <section className="liveTopology" data-testid="live-topology" aria-label="생성 중 Agent 연결 구조">
    <header><div><span>LIVE COLLABORATION</span><h2>현재 Agent 연결 구조</h2></div><b>{selectedCount ? selectedCount + "개 Agent 선택" : "선택 분석 중"}</b></header>
    <p>Core 중심 연결 · 실제 실행 상태에 따라 연결선과 Agent 상태가 바뀝니다.</p>
    <div className="topologyScroll" tabIndex={0} aria-label="Agent 연결도. 좁은 화면에서는 좌우로 이동할 수 있습니다.">
      <div className="topologyCanvas">
        <svg className="topologyDesktopWires" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
          {agents.map((agent, index) => {
            const live = state.agents[agent.id];
            const x = index < 4 ? 275 : 725, y = 50 + (index % 4) * 100;
            const connected = live?.selected === true;
            const active = connected && activeStages.includes(live.stage);
            const done = connected && finishedStages.includes(live.stage);
            return <path key={agent.id} d={"M500,200 C" + x + ",200 500," + y + " " + x + "," + y}
              className={active ? "flowing" : done && integrating ? "returning" : connected ? "connected" : "inactive"}
              style={{ "--agent": agent.color } as React.CSSProperties} />;
          })}
        </svg>
        <svg className="topologyMobileWires" viewBox="0 0 1000 820" preserveAspectRatio="none" aria-hidden="true">
          {agents.map((agent, index) => {
            const live = state.agents[agent.id];
            const active = live?.selected && activeStages.includes(live.stage);
            const done = live?.selected && finishedStages.includes(live.stage);
            return <path key={agent.id} d={"M500,50 H35 V" + (145 + index * 90) + " H100"}
              className={active ? "flowing" : done && integrating ? "returning" : live?.selected ? "connected" : "inactive"}
              style={{ "--agent": agent.color } as React.CSSProperties} />;
          })}
        </svg>
        <div className={"topologyCore " + (integrating ? "integrating" : "")}><span>{coreLabel}</span><strong>{coreStatus}</strong><small>{state.mode === "centralized" || state.mode === "remoterag" ? "전문 근거 수집 · 중앙 생성" : "선택 · 요청 전달 · 결과 통합"}</small></div>
        {agents.map((agent, index) => {
          const live = state.agents[agent.id];
          const selected = live?.selected === true;
          const active = selected && activeStages.includes(live.stage);
          const role = state.routerDecision?.primaryAgent === agent.id ? "주관" : state.routerDecision?.required.includes(agent.id) ? "필수 검토" : "선택됨";
          return <article key={agent.id} data-agent={agent.id} data-selected={String(selected)}
            className={"topologyAgent " + (selected ? "selected " : "") + (active ? "working" : "")}
            style={{ gridColumn: index < 4 ? 1 : 3, gridRow: index % 4 + 1, "--agent": agent.color } as React.CSSProperties}>
            <div><strong>{agent.shortName} Agent</strong><b>{selected ? role : live?.selected === false ? "미선택" : "검토 중"}</b></div>
            <small><i aria-hidden="true" />{selected ? stageLabel(live.stage) : live?.selected === false ? "현재 호출 대상이 아님" : "요청과 담당 영역 비교 중"}</small>
          </article>;
        })}
      </div>
    </div>
    <div className="topologyLegend"><span>● 선택된 Agent</span><span>┄ 움직이는 선: 현재 처리 중</span><span>○ 흐린 Agent: 미선택·검토 대기</span></div>
  </section>;
}
