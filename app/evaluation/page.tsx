const results = [
  { name: "Single Centralized RAG", quality: 81.6, deviation: 5.1, correctness: 79.5, groundedness: 82.2, completeness: 83.1, ttft: "18.36초", tpot: "110.9ms", latency: "57.0초", bytes: "52,788B", leaves: "전송" },
  { name: "All-Agent Aggregation", quality: 81.3, deviation: 4.9, correctness: 79.3, groundedness: 80.9, completeness: 83.3, ttft: "5.69초", tpot: "157.4ms", latency: "59.6초", bytes: "6,718B", leaves: "미전송" },
  { name: "MasRouter-inspired", quality: 74.1, deviation: 5.5, correctness: 75.2, groundedness: 74.5, completeness: 72.3, ttft: "2.21초", tpot: "133.4ms", latency: "58.9초", bytes: "1,426B", leaves: "전송" },
  { name: "RemoteRAG-inspired", quality: 70.0, deviation: 10.3, correctness: 71.9, groundedness: 68.1, completeness: 69.7, ttft: "4.58초", tpot: "104.0ms", latency: "60.0초", bytes: "4,649B", leaves: "전송" },
  { name: "제안 방식", quality: 76.5, deviation: 4.7, correctness: 77.1, groundedness: 75.3, completeness: 76.7, ttft: "3.78초", tpot: "152.2ms", latency: "59.2초", bytes: "3,479B", leaves: "미전송" },
];

export default function EvaluationPage() {
  return (
    <main className="aboutPage evaluationPage">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brandMark">M</span>
          <div><strong>MNC FLOW</strong><small>KOREN Distributed AI Governance</small></div>
        </a>
        <nav className="navLinks" aria-label="주요 페이지">
          <a className="aboutLink" href="/about">서비스 소개</a>
          <a className="aboutLink" href="/">실행 화면</a>
        </nav>
      </header>

      <section className="aboutHero evaluationHero">
        <span className="eyebrow">REPEATED COMPARATIVE EVALUATION</span>
        <h1>문헌 기반 baseline보다 높은 품질,<br />원문은 데이터 경계 안에.</h1>
        <p>5개 공공·기업 AX 복합 질의를 다섯 방식에 각각 3회 적용했습니다. 총 75개 실제 응답을 동일한 상용 LLM 블라인드 평가자로 채점하고, 품질·속도·데이터 이동을 함께 비교했습니다.</p>
        <div className="evaluationSummary">
          <div><span>총 평가 실행</span><strong>75</strong><small>5질의 × 5방식 × 3회</small></div>
          <div><span>품질 유지율</span><strong>93.8%</strong><small>최고 품질 방식 대비</small></div>
          <div><span>전송량 절감</span><strong>48.2%</strong><small>전체 Multi-Agent 대비</small></div>
          <div><span>문헌 baseline 우위</span><strong>+2.4</strong><small>MasRouter-inspired 대비</small></div>
        </div>
      </section>

      <section className="evaluationBody">
        <article>
          <div className="evaluationSectionHead">
            <span>01</span>
            <div><h2>반복평가 결과</h2><p>모든 수치는 15개 응답의 평균이며, 종합 품질 옆 ± 값은 반복 변동을 나타내는 표준편차입니다.</p></div>
          </div>
          <div className="evaluationTableWrap">
            <div className="evaluationTable">
              <div className="evaluationTableHead"><span>방식</span><span>종합 품질</span><span>정확성</span><span>근거충실도</span><span>완전성</span><span>TTFT</span><span>TPOT</span><span>원문 외부 전송</span></div>
              {results.map((result) => (
                <div key={result.name} className={result.name === "제안 방식" ? "evaluationHighlight" : ""}>
                  <strong>{result.name}</strong>
                  <span>{result.quality} <small>±{result.deviation}</small></span>
                  <span>{result.correctness}</span>
                  <span>{result.groundedness}</span>
                  <span>{result.completeness}</span>
                  <span>{result.ttft}</span>
                  <span>{result.tpot}</span>
                  <b className={result.leaves === "미전송" ? "safeValue" : "riskValue"}>{result.leaves}</b>
                </div>
              ))}
            </div>
          </div>
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>02</span>
            <div><h2>무엇이 더 좋은가</h2><p>제안 방식은 절대 품질 1위가 아니라, 공공기관과 기업 AX에서 중요한 품질·보호·속도의 균형을 목표로 합니다.</p></div>
          </div>
          <div className="tradeoffGrid">
            <section><b>QUALITY</b><strong>76.5점</strong><p>MasRouter-inspired보다 2.4점, RemoteRAG-inspired보다 6.5점 높고 최고 품질의 93.8%를 유지했습니다.</p></section>
            <section><b>DATA</b><strong>3,479B</strong><p>전체 Multi-Agent보다 48.2%, 중앙집중형보다 93.4% 적은 데이터만 Core로 전달합니다.</p></section>
            <section><b>RESPONSIVENESS</b><strong>3.78초</strong><p>중앙집중형보다 TTFT가 79.4% 짧으며, E2E는 All-Agent와 유사했습니다.</p></section>
            <section><b>BOUNDARY</b><strong>원문 미전송</strong><p>MasRouter·RemoteRAG-inspired와 달리 조직 원문을 Core 또는 원격 검색 경계로 보내지 않습니다.</p></section>
          </div>
          <p className="evaluationClaim">결론: 제안 방식은 문헌 기반 routing·privacy RAG baseline보다 높은 품질을 보이면서 원문 비이동을 유지했고, 전체 Agent 실행 대비 Core 전송량을 절반가량 줄였습니다.</p>
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>03</span>
            <div><h2>실험 설계와 산식</h2><p>결과를 재현할 수 있도록 비교 조건과 계산 기준을 고정했습니다.</p></div>
          </div>
          <div className="methodGrid">
            <div><b>질의 구성</b><p>개인정보·클라우드·법무·예산, RAG 데이터·접근통제·SLA, 조달·종속성·검수, 환각·편향·책임, 로컬·외부 LLM 비교 등 5개 복합 질의</p></div>
            <div><b>반복 조건</b><p>각 질의를 중앙집중형·전체 Agent·MasRouter-inspired·RemoteRAG-inspired·제안 방식에 3회씩 적용해 방식당 15개 응답을 확보</p></div>
            <div><b>품질 평가</b><p>방식 이름을 평가 프롬프트에서 제외한 상용 LLM 블라인드 평가로 정확성·근거충실도·완전성을 0~100점으로 채점</p></div>
            <div><b>품질 유지율</b><code>제안 방식 평균 품질 ÷ 최고 방식 평균 품질 × 100</code></div>
            <div><b>전송량 절감률</b><code>(비교 방식 전송량 − 제안 방식 전송량) ÷ 비교 방식 전송량 × 100</code></div>
            <div><b>속도 측정</b><p>TTFT는 요청부터 첫 토큰까지, TPOT는 첫 토큰 이후 토큰당 평균 생성시간, E2E는 전체 응답 완료시간으로 측정</p></div>
          </div>
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>04</span>
            <div><h2>해석 시 주의사항</h2><p>이 결과가 말할 수 있는 범위와 아직 확장해야 할 부분을 구분합니다.</p></div>
          </div>
          <ul className="limitations">
            <li><strong>현재 결론</strong><span>선정한 5개 AX 질의와 현재 로컬 환경에서 제안 방식은 최고 품질의 93.8%를 유지하고 문헌 기반 inspired baseline보다 높은 품질과 원문 비이동을 보였습니다.</span></li>
            <li><strong>재현 범위</strong><span>MasRouter의 학습 controller와 RemoteRAG의 DistanceDP 전체를 재현한 것이 아니라, 공개된 핵심 메커니즘을 동일 로컬 환경에 맞춘 inspired baseline입니다.</span></li>
            <li><strong>아직 아닌 것</strong><span>모든 업무와 모든 모델에서 같은 결과가 보장된다는 일반화된 성능 증명은 아닙니다.</span></li>
            <li><strong>다음 검증</strong><span>전문가가 정답과 필수 개념을 부여한 30~50개 이상의 평가셋으로 Agent F1, Retrieval Recall@K, 정답 기반 품질과 95% 신뢰구간을 추가해야 합니다.</span></li>
          </ul>
        </article>
      </section>

      <footer><span>MNC Lab. · Korea University</span><div className="footerLinks"><a href="/about">서비스 소개</a><a href="/">MNC FLOW 실행 화면</a></div></footer>
    </main>
  );
}
