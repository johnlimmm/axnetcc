import Link from "next/link";

const acquisitionMain = [
  { name: "Raw central", completion: 0.997, violation: 0.923, coverage: 0.997, raw: "3,357.199 B" },
  { name: "Always local", completion: 0.722, violation: 0, coverage: 0.906, raw: "0 B" },
  { name: "Fixed sanitized", completion: 0.859, violation: 0, coverage: 0.952, raw: "0 B" },
  { name: "Network only", completion: 0, violation: 0, coverage: 0, raw: "0 B" },
  { name: "Security only", completion: 0.738, violation: 0, coverage: 0.910, raw: "332.166 B" },
  { name: "AXNetCC-SAEA", completion: 0.860, violation: 0, coverage: 0.860, raw: "115.329 B" },
  { name: "Oracle feasible", completion: 0.861, violation: 0, coverage: 0.861, raw: "115.329 B" },
];

const acquisitionValidation = [
  { name: "Raw central", completion: 0.759, violation: 0.675, coverage: 0.891, raw: "3,502.363 B" },
  { name: "Always local", completion: 0.645, violation: 0, coverage: 0.827, raw: "0 B" },
  { name: "Fixed sanitized", completion: 0.739, violation: 0, coverage: 0.879, raw: "0 B" },
  { name: "Network only", completion: 0, violation: 0, coverage: 0, raw: "0 B" },
  { name: "Security only", completion: 0.681, violation: 0, coverage: 0.854, raw: "1,260.022 B" },
  { name: "AXNetCC-SAEA", completion: 0.723, violation: 0, coverage: 0.685, raw: "276.167 B" },
  { name: "Oracle feasible", completion: 0.743, violation: 0, coverage: 0.705, raw: "285.949 B" },
];

const routerResults = [
  { name: "Static", f1: 0.604, exact: 0.175, fanout: 2.17 },
  { name: "Top-k", f1: 0.599, exact: 0.150, fanout: 2.20 },
  { name: "Threshold", f1: 0.578, exact: 0.150, fanout: 1.48 },
  { name: "MasRouter adapted", f1: 0.300, exact: 0.025, fanout: 2.60 },
  { name: "RouteLLM-MF adapted", f1: 0.337, exact: 0.075, fanout: 2.13 },
  { name: "IRT-Router adapted", f1: 0.353, exact: 0, fanout: 2.65 },
  { name: "AXNetCC proposed", f1: 0.665, exact: 0.250, fanout: 3.20 },
];

function AcquisitionTable({ rows }: { rows: typeof acquisitionMain }) {
  return <div className="evaluationTableWrap"><div className="evaluationTable acquisitionTable">
    <div className="evaluationTableHead"><span>방식</span><span>Evidence completion</span><span>Policy violation</span><span>Runtime coverage</span><span>Raw boundary bytes</span></div>
    {rows.map((row) => <div key={row.name} className={row.name === "AXNetCC-SAEA" ? "evaluationHighlight" : ""}>
      <strong>{row.name}</strong><span>{row.completion.toFixed(3)}</span><b className={row.violation ? "riskValue" : "safeValue"}>{row.violation.toFixed(3)}</b><span>{row.coverage.toFixed(3)}</span><span>{row.raw}</span>
    </div>)}
  </div></div>;
}

export default function EvaluationPage() {
  return <main className="aboutPage evaluationPage">
    <header className="topbar">
      <Link className="brand" href="/"><span className="brandMark">A</span><div><strong>AXNETCC v2</strong><small>Security-Aware Evidence Acquisition</small></div></Link>
      <nav className="navLinks" aria-label="주요 페이지"><Link className="aboutLink" href="/about">연구 소개</Link><Link className="aboutLink" href="/">실행 화면</Link></nav>
    </header>

    <section className="aboutHero evaluationHero">
      <span className="eyebrow">PAPER-GRADE EVALUATION / ACTUAL HTTP</span>
      <h1>데이터 주권과 근거 완성도를,<br />하나의 라우팅으로 연결합니다.</h1>
      <p>AXNetCC-SAEA는 부서별 Agent가 데이터 소유권을 유지한 채, 실제 네트워크 상태와 보안 등급에 맞는 근거 형태를 실시간으로 선택합니다. 29,664개 실행과 61,470개 HTTP trace로 성능을 검증했습니다.</p>
      <div className="evaluationSummary">
        <div><span>MAIN JOBS</span><strong>24,624</strong><small>49,248 raw HTTP traces</small></div>
        <div><span>VALIDATION JOBS</span><strong>5,040</strong><small>40-query · 12,222 traces</small></div>
        <div><span>SAEA VIOLATION</span><strong>0.000</strong><small>main + validation</small></div>
        <div><span>TRANSPORT FAILURE</span><strong>0</strong><small>validator confirmed</small></div>
      </div>
    </section>

    <section className="evaluationBody">
      <article>
        <div className="evaluationSectionHead"><span>01</span><div><h2>Main acquisition study</h2><p>6개 fixed-role golden query, 7개 방식, 6개 network scenario, 3개 security-profile seed, 방식별 30회 반복입니다.</p></div></div>
        <AcquisitionTable rows={acquisitionMain} />
        <p className="evaluationClaim">AXNetCC-SAEA는 policy violation 0을 유지하면서 completion 0.860을 기록해 oracle-feasible 0.861에 근접했습니다. Raw central은 completion 0.997이지만 policy violation 0.923과 평균 3,357 B의 raw 경계 전송을 동반했습니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>02</span><div><h2>40-query 확장 검증</h2><p>40개 semantic-family query와 role-concept manifest로 다양한 공공·기업 AX 업무까지 검증 범위를 확장했습니다.</p></div></div>
        <AcquisitionTable rows={acquisitionValidation} />
        <p className="evaluationClaim">확장 검증에서도 SAEA는 policy violation 0을 유지하며 completion 0.723을 달성했습니다. Raw central 대비 raw 경계 전송을 92.1% 줄여, 더 넓은 업무군에서도 보안–근거 균형을 안정적으로 유지했습니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>03</span><div><h2>근거 전달의 네 가지 선택</h2><p>각 부서의 고정 Agent가 근거를 소유하고, Core는 보안 허용성·필수 개념 coverage·network 비용을 만족하는 전달 형태만 선택합니다.</p></div></div>
        <div className="evidenceModeGrid">
          <section><b>RAW</b><strong>원문 전달</strong><p>public 또는 owner-local처럼 정책이 허용하고 coverage가 필요한 경우에만 사용합니다.</p></section>
          <section><b>SANITIZED</b><strong>민감필드 제거</strong><p>직접 식별자·내부 IP·계좌·secret 패턴을 제거하고 근거 handle을 유지합니다.</p></section>
          <section><b>LOCAL-SUMMARY</b><strong>소유부서 요약</strong><p>원문은 부서에 남기고 필수 개념과 evidence ID가 포함된 최소 요약을 전송합니다.</p></section>
          <section><b>METADATA-ONLY</b><strong>내용 미전달</strong><p>content 없이 canonical ID, 소유부서, 민감도, 유효일자만 전달합니다.</p></section>
        </div>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>04</span><div><h2>Router baseline과 최신기법 adapter</h2><p>기존 static/top-k/threshold와 MasRouter, RouteLLM-MF, IRT-Router의 공개 핵심 메커니즘을 AX 역할선택 문제에 맞춘 adapter를 함께 비교했습니다.</p></div></div>
        <div className="evaluationTableWrap"><div className="evaluationTable routerTable">
          <div className="evaluationTableHead"><span>방식</span><span>Macro-F1</span><span>Exact match</span><span>평균 fan-out</span></div>
          {routerResults.map((row) => <div key={row.name} className={row.name === "AXNetCC proposed" ? "evaluationHighlight" : ""}><strong>{row.name}</strong><span>{row.f1.toFixed(3)}</span><span>{row.exact.toFixed(3)}</span><span>{row.fanout.toFixed(2)}</span></div>)}
        </div></div>
        <p className="evaluationClaim">AXNetCC proposed는 40-query 평가에서 macro-F1 0.665와 exact match 0.250으로 비교군 중 가장 높은 역할선택 성능을 기록했습니다. 서로 다른 최신 routing 메커니즘을 동일한 AX 역할선택 조건에서 함께 평가했습니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>05</span><div><h2>Qwen · Llama · Gemma · OpenAI 교차검증</h2><p>같은 순서의 40개 query를 기존 label과 방식 이름을 숨긴 채 네 모델 계열에 제시했습니다.</p></div></div>
        <div className="judgeGrid">
          <section><span>LOCAL PAIRWISE JACCARD</span><strong>0.267</strong><small>95% bootstrap CI [0.230, 0.309]</small></section>
          <section><span>LOCAL FLEISS&apos; KAPPA</span><strong>0.041</strong><small>8개 binary role decision</small></section>
          <section><span>OPENAI ↔ AUTHOR F1</span><strong>0.815</strong><small>precision 0.732 · recall 0.918</small></section>
          <section><span>4-MODEL KAPPA</span><strong>0.123</strong><small>model-family sensitivity</small></section>
        </div>
        <p className="evaluationClaim">OpenAI judge는 author label 대비 recall 0.918과 micro-F1 0.815를 기록했습니다. 네 모델 계열의 차이를 함께 측정해 핵심 역할과 지원 역할을 구분하는 차세대 soft-routing 기준까지 확보했습니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>06</span><div><h2>검증 자산과 확장성</h2><p>결과뿐 아니라 실험을 다시 실행하고 확장할 수 있는 전체 연구 자산을 제공합니다.</p></div></div>
        <ul className="limitations">
          <li><strong>통계 설계</strong><span>Unique query를 sampling unit으로 사용하고 query-cluster bootstrap, paired permutation, Holm 보정을 적용했습니다.</span></li>
          <li><strong>무결성</strong><span>Main과 validation validator 통과, transport failure 0, paper artifact 47/47 SHA-256 일치를 확인했습니다.</span></li>
          <li><strong>원시 자산</strong><span>실행 설정, query bootstrap, ablation, request-level 결과와 raw HTTP trace를 함께 보존합니다.</span></li>
          <li><strong>확장 경로</strong><span>동일한 Gateway·proxy·manifest 구조를 기관망, packet-level 계측, 전문가 평가로 확장할 수 있습니다.</span></li>
        </ul>
      </article>
    </section>

    <footer><span>AXNetCC v2 · paper-full-v4-20260806</span><div className="footerLinks"><Link href="/about">연구 소개</Link><Link href="/">실행 화면</Link></div></footer>
  </main>;
}
