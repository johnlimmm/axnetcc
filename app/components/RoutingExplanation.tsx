import type { RouterDecisionView } from "../page";

type Participant = { id: string; shortName: string; color: string; executionRole?: string; selectionReason?: string };
const components: Record<string, string> = { profileSimilarity: "프로필 유사도", keywordEntity: "키워드·개체 일치", domainSignal: "업무 영역 신호", evidenceReadiness: "근거 준비도", missRisk: "검토 누락 위험", costEfficiency: "호출 비용 효율" };
const rules: Record<string, string> = {
  "personal-data-security-owner": "개인정보 관련 요청은 보안 Agent가 주관하도록 지정하는 규칙",
  "confidential-boundary-security-owner": "기밀 정보의 경계를 보안 Agent가 검토하도록 지정하는 규칙",
  "explicit-procurement-owner": "발주·입찰·조달 관련 요청을 조달 Agent가 주관하도록 지정하는 규칙",
};
const format = (value: number | undefined) => typeof value === "number" ? value.toFixed(3) : "미기록";

export default function RoutingExplanation({ decision, agents, mode }: { decision?: RouterDecisionView | null; agents: Participant[]; mode: string }) {
  const selection = decision?.primarySelection;
  const labels: Record<string, string> = { tech: "기술", data: "데이터", security: "보안", legal: "법무", policy: "정책", finance: "재무", procurement: "조달", operations: "운영" };
  const name = (id: string) => agents.find(agent => agent.id === id)?.shortName ?? labels[id] ?? id;
  const conceptName = (id: string) => decision?.requiredConcepts.find(concept => concept.id === id)?.label ?? id;
  return <section className="routingExplanation" data-testid="routing-explanation" aria-labelledby="routing-explanation-title">
    <header><span>03 · AGENT SELECTION</span><h2 id="routing-explanation-title">Agent 선택 이유</h2><p>요청 단어와 Agent 프로필의 일치 항목, 주관·보조 Agent의 선택 근거를 표시합니다.</p></header>
    {selection ? <>
      <div className="routingMethod"><strong>단어·문자열 기반 프로필 매칭</strong><p>현재 라우터는 학습된 임베딩 벡터 대신 요청 단어와 Agent 프로필의 일치·포함 관계, 두 글자 단위의 겹침을 비교합니다. 아래 값은 실제 계산된 문자열 유사도이며 의미 이해의 확률은 아닙니다.</p></div>
      {selection.hardGate.applied && <p className="routingPolicy" role="note">주관 선정에는 점수 순위보다 필수 규칙이 우선 적용됐습니다: {selection.hardGate.reasons.map(reason => rules[reason] ?? reason).join(" · ")}.</p>}
      {selection.fallbackUsed && <p className="routingPolicy" role="note">{selection.fallbackReason === "hybrid-score-below-threshold" ? "최고 종합 점수가 기준값에 못 미쳐" : "상위 후보의 점수 차이가 작아"} 업무 신호 규칙으로 주관 Agent를 결정했습니다. 단순 점수 1위와 실제 주관이 다를 수 있습니다.</p>}
    </> : <p className="routingMethod">{mode === "parallel" ? "전체 병렬 실행 옵션에 따라 모든 Agent를 호출했습니다." : mode === "centralized" || mode === "remoterag" ? "선택한 실행 방식에 따라 전문 영역의 근거를 수집하고 중앙에서 보고서를 생성했습니다." : "이 실행에는 단어별 라우팅 점수가 기록되지 않았습니다."}</p>}
    <div className="selectionCards">{agents.map(agent => {
      const score = selection?.rankedCandidates.find(candidate => candidate.agentId === agent.id);
      const primary = decision?.primaryAgent === agent.id;
      const support = decision?.supportSelection?.find(item => item.agentId === agent.id);
      const required = support?.reason === "required-review" || decision?.required.includes(agent.id);
      const matches = [...(score?.profileMatches ?? [])].filter(match => match.affinity >= 0.5).sort((a, b) => b.contribution - a.contribution).slice(0, 6);
      const concepts = support?.missingConceptIds ?? [];
      const reason = primary
        ? selection?.hardGate.applied ? "필수 정책 규칙에 따라 주관 역할을 맡았습니다." : selection?.fallbackUsed ? "후보 점수가 불확실해 업무 신호 규칙으로 주관 역할을 맡았습니다." : "요청과 담당 영역을 비교한 종합 점수가 가장 높아 주관 역할을 맡았습니다."
        : support?.reason === "coverage-gap" ? "주관 Agent의 1차 검토에서 빠진 필수 개념을 보완하기 위해 추가됐습니다."
        : required ? "개인정보·기밀·조달 등 요청에 적용된 필수 검토 규칙에 따라 함께 선택됐습니다."
        : agent.selectionReason ?? "선택한 실행 방식에 따라 참여했습니다.";
      return <article key={agent.id} className={primary ? "primarySelection" : "supportSelection"} style={{ "--agent": agent.color } as React.CSSProperties}>
        <header><div><span>{primary ? "주관 AGENT" : required ? "필수 검토 AGENT" : "보조 AGENT"}</span><h3>{agent.shortName} Agent</h3></div>{score && <b>종합 {format(score.totalScore)}<small>후보 {score.rank}위 / 0–1</small></b>}</header>
        <p>{reason}</p>
        {!!score?.matchedTerms?.length && <div className="matchedTerms"><strong>요청에서 일치한 키워드</strong>{score.matchedTerms.map(term => <mark key={term}>{term}</mark>)}</div>}
        {!!concepts.length && <div className="missingConcepts"><strong>추가 검토가 필요했던 개념</strong><p>{concepts.map(conceptName).join(" · ")}</p></div>}
        {matches.length ? <div className="tokenMatches"><div className="tokenMatchHeading"><span>요청 단어 → Agent 프로필 단어</span><span>유사도 · 점수 기여</span></div>{matches.map(match => <div key={match.requestToken}><span><b>{match.requestToken}</b><i>→</i>{match.profileToken}</span><span>{format(match.affinity)}<small>+{format(match.contribution)}</small></span></div>)}<p>기여도는 프로필 항목에서 종합 점수에 더해지는 값입니다. 유사도 0.5 이상인 상위 6개 단어만 표시합니다.</p></div> : score && <p className="routingMuted">뚜렷한 단어 쌍이 기록되지 않았습니다. 필수 규칙과 다른 점수 항목을 함께 확인하세요.</p>}
        {score && <details className="scoreDetails"><summary>종합 점수의 구성 보기</summary><dl>{Object.entries(components).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{format(score.components[key as keyof typeof score.components])}{score.weightedComponents && <small>종합에 +{format(score.weightedComponents[key])}</small>}</dd></div>)}</dl><p>단어 유사도를 포함한 여러 항목의 가중합입니다. 표시값은 소수 셋째 자리에서 반올림합니다. 보조 Agent의 점수는 주관 후보 비교값이며, 추가 호출 여부는 필수 규칙과 근거 공백으로 결정됩니다.</p></details>}
      </article>;
    })}</div>
    {selection && <details className="candidateComparison"><summary>전체 주관 후보 비교 · 1·2위 점수 차이 {format(selection.top1Top2Margin)}</summary><div className="candidateRows">{selection.rankedCandidates.map(candidate => <div key={candidate.agentId}><span>{candidate.rank}위</span><strong>{name(candidate.agentId)}</strong><meter min="0" max="1" value={candidate.totalScore} aria-label={name(candidate.agentId) + " 종합 점수"} /><b>{format(candidate.totalScore)}</b><small>{candidate.agentId === decision?.primaryAgent ? "주관 선정" : agents.some(agent => agent.id === candidate.agentId) ? "보조 참여" : "미선택"}</small></div>)}</div></details>}
  </section>;
}
