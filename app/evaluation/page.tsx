const results = [
  { name: "중앙집중형", quality: 80.9, deviation: 4.8, correctness: 79.3, groundedness: 82.7, completeness: 80.5, ttft: "21.40초", tpot: "125.1ms", latency: "54.0초", bytes: "52,788B", leaves: "전송" },
  { name: "상용 Managed Supervisor", quality: 77.7, deviation: 5.9, correctness: 78.1, groundedness: 75.9, completeness: 78.9, ttft: "2.69초", tpot: "134.7ms", latency: "77.9초", bytes: "56,267B", leaves: "전송" },
  { name: "전체 Multi-Agent", quality: 82.3, deviation: 4.4, correctness: 79.9, groundedness: 83.3, completeness: 83.4, ttft: "5.41초", tpot: "136.1ms", latency: "64.4초", bytes: "6,718B", leaves: "미전송" },
  { name: "제안 방식", quality: 77.1, deviation: 4.0, correctness: 77.2, groundedness: 74.5, completeness: 78.4, ttft: "2.35초", tpot: "107.7ms", latency: "70.1초", bytes: "3,479B", leaves: "미전송" },
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
        <h1>최고 품질의 93.7%를 유지하며,<br />전송 데이터는 48.2% 줄였습니다.</h1>
        <p>5개 공공·기업 AX 복합 질의를 네 방식에 각각 3회 적용했습니다. 총 60개 실제 응답을 동일한 상용 LLM 블라인드 평가자로 채점하고, 품질·속도·데이터 이동을 함께 비교했습니다.</p>
        <div className="evaluationSummary">
          <div><span>총 평가 실행</span><strong>60</strong><small>5질의 × 4방식 × 3회</small></div>
          <div><span>품질 유지율</span><strong>93.7%</strong><small>최고 품질 방식 대비</small></div>
          <div><span>전송량 절감</span><strong>48.2%</strong><small>전체 Multi-Agent 대비</small></div>
          <div><span>반복 안정성</span><strong>±4.0</strong><small>가장 낮은 표준편차</small></div>
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
            <section><b>QUALITY</b><strong>77.1점</strong><p>전체 Multi-Agent 82.3점 대비 5.2점 낮지만 최고 품질의 93.7%를 유지했습니다.</p></section>
            <section><b>DATA</b><strong>3,479B</strong><p>전체 Multi-Agent보다 48.2%, 중앙집중형보다 93.4% 적은 데이터만 Core로 전달합니다.</p></section>
            <section><b>RESPONSIVENESS</b><strong>2.35초</strong><p>평균 TTFT가 네 방식 중 가장 짧고, TPOT도 107.7ms로 가장 빠릅니다.</p></section>
            <section><b>STABILITY</b><strong>±4.0점</strong><p>종합 품질 표준편차가 가장 낮아 반복 실행 시 결과 변동이 가장 작았습니다.</p></section>
          </div>
          <p className="evaluationClaim">결론: 제안 방식은 전체 Agent를 항상 실행하는 방식에 가까운 품질을 유지하면서, 필요한 Agent만 선택해 원문 이동과 Core 전송량을 줄이는 균형형 구조입니다.</p>
        </article>

        <article>
          <div className="evaluationSectionHead">
            <span>03</span>
            <div><h2>실험 설계와 산식</h2><p>결과를 재현할 수 있도록 비교 조건과 계산 기준을 고정했습니다.</p></div>
          </div>
          <div className="methodGrid">
            <div><b>질의 구성</b><p>개인정보·클라우드·법무·예산, RAG 데이터·접근통제·SLA, 조달·종속성·검수, 환각·편향·책임, 로컬·외부 LLM 비교 등 5개 복합 질의</p></div>
            <div><b>반복 조건</b><p>각 질의를 중앙집중형·Managed Supervisor·전체 Multi-Agent·제안 방식에 3회씩 적용해 방식당 15개 응답을 확보</p></div>
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
            <li><strong>현재 결론</strong><span>선정한 5개 공공·기업 AX 질의와 현재 로컬 실행환경에서는 제안 방식이 품질을 93.7% 유지하며 데이터 이동과 생성속도에서 이점을 보였습니다.</span></li>
            <li><strong>아직 아닌 것</strong><span>모든 업무와 모든 모델에서 같은 결과가 보장된다는 일반화된 성능 증명은 아닙니다.</span></li>
            <li><strong>다음 검증</strong><span>전문가가 정답과 필수 개념을 부여한 30~50개 이상의 평가셋으로 Agent F1, Retrieval Recall@K, 정답 기반 품질과 95% 신뢰구간을 추가해야 합니다.</span></li>
          </ul>
        </article>
      </section>

      <footer><span>MNC Lab. · Korea University</span><div className="footerLinks"><a href="/about">서비스 소개</a><a href="/">MNC FLOW 실행 화면</a></div></footer>
    </main>
  );
}
