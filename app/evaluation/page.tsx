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
      <h1>보안 경계를 지키면서,<br />필요한 근거는 끝까지 전달합니다.</h1>
      <p>실제 HTTP Evidence Gateway와 application-layer network proxy에서 비교실험·ablation·query-cluster bootstrap을 수행했습니다. SAEA 결과와 Router 결과를 분리하고, 다중 LLM 검증에서 확인된 label sensitivity를 그대로 공개합니다.</p>
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
        <div className="evaluationSectionHead"><span>02</span><div><h2>40-query acquisition validation</h2><p>40개 semantic-family query와 derived role-concept manifest로 범위를 확장했습니다. 13개 mapping은 deterministic fallback이므로 독립 confirmatory gold set으로 표현하지 않습니다.</p></div></div>
        <AcquisitionTable rows={acquisitionValidation} />
        <p className="evaluationClaim">확장 검증에서 SAEA completion은 0.723, policy violation은 0, raw boundary bytes는 276.167 B였습니다. Fixed sanitized의 completion 0.739보다 낮아, 모든 조건에서 SAEA가 지배적이라고 주장하지 않습니다.</p>
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
        <p className="evaluationClaim">AXNetCC proposed는 이 author-labelled 40-query split에서 macro-F1 0.665였습니다. Adapter 행은 upstream benchmark의 정확한 재현이 아니며, 다중 LLM 실험에서 label sensitivity가 확인됐으므로 routing superiority는 탐색적 결과입니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>05</span><div><h2>Qwen · Llama · Gemma · OpenAI 교차검증</h2><p>같은 순서의 40개 query를 기존 label과 방식 이름을 숨긴 채 네 모델 계열에 제시했습니다.</p></div></div>
        <div className="judgeGrid">
          <section><span>LOCAL PAIRWISE JACCARD</span><strong>0.267</strong><small>95% bootstrap CI [0.230, 0.309]</small></section>
          <section><span>LOCAL FLEISS&apos; KAPPA</span><strong>0.041</strong><small>8개 binary role decision</small></section>
          <section><span>OPENAI ↔ AUTHOR F1</span><strong>0.815</strong><small>precision 0.732 · recall 0.918</small></section>
          <section><span>4-MODEL KAPPA</span><strong>0.123</strong><small>model-family sensitivity</small></section>
        </div>
        <p className="evaluationClaim">OpenAI judge는 author label을 높은 recall로 복원했지만 평균 3.825개 역할을 선택해 과다선택 경향을 보였습니다. 어느 LLM도 독립 인간 gold set을 대신한다고 주장하지 않습니다.</p>
      </article>

      <article>
        <div className="evaluationSectionHead"><span>06</span><div><h2>재현성과 주장 경계</h2><p>원시 trace와 결과를 남기되 실험이 말할 수 없는 범위를 명시합니다.</p></div></div>
        <ul className="limitations">
          <li><strong>재현 단위</strong><span>통계 sampling unit은 HTTP trace가 아니라 unique query입니다. P95도 query-method cluster 안에서 먼저 계산합니다.</span></li>
          <li><strong>무결성</strong><span>Main과 validation validator 통과, transport failure 0, paper artifact manifest 47/47 SHA-256 일치입니다.</span></li>
          <li><strong>가능한 주장</strong><span>Application-layer HTTP 환경에서 정책 위반 없이 경쟁력 있는 evidence completion과 낮은 raw 경계 전송을 보였습니다.</span></li>
          <li><strong>불가능한 주장</strong><span>물리 KOREN·packet-level 측정, 실제 기관 비밀정보 검증, 법적 준수 보장, 독립 전문가 gold validation은 주장하지 않습니다.</span></li>
        </ul>
      </article>
    </section>

    <footer><span>AXNetCC v2 · paper-full-v4-20260806</span><div className="footerLinks"><Link href="/about">연구 소개</Link><Link href="/">실행 화면</Link></div></footer>
  </main>;
}
