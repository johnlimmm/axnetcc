import Link from "next/link";

export default function AboutPage() {
  return <main className="aboutPage">
    <header className="topbar">
      <Link className="brand" href="/"><span className="brandMark">A</span><div><strong>AXNETCC v2</strong><small>Security-Aware Evidence Acquisition</small></div></Link>
      <nav className="navLinks" aria-label="주요 페이지"><Link className="aboutLink" href="/evaluation">평가 결과</Link><Link className="aboutLink" href="/">실행 화면</Link></nav>
    </header>

    <section className="aboutHero">
      <span className="eyebrow">SYSTEM & RESEARCH OVERVIEW</span>
      <h1>Agent는 부서에 남고,<br />근거만 안전하게 이동합니다.</h1>
      <p>AXNetCC v2는 부서별 고유 Agent, 로컬 RAG, 고정 endpoint를 하나의 지능형 협업망으로 연결합니다. 복합 AX 질의에 필요한 전문성과 evidence 전달 형태를 동시에 결정해 데이터 주권과 실행력을 함께 확보합니다.</p>
    </section>

    <section className="aboutContent">
      <article><span className="aboutNumber">01</span><div><h2>문제 정의</h2><p>중앙집중형 RAG는 여러 부서의 원문을 한곳에 모아 높은 coverage를 얻기 쉽지만 개인정보·내부자료·비밀정보의 경계 전송을 확대합니다. 반대로 모든 원문을 로컬에만 두면 필요한 근거가 부족해질 수 있습니다. AXNetCC v2는 “누가 답할 것인가”와 “어떤 형태의 근거를 보낼 것인가”를 분리해 함께 최적화합니다.</p></div></article>

      <article><span className="aboutNumber">02</span><div><h2>고정된 부서 Agent와 endpoint</h2><p>기술·데이터·정보보호·법무·정책·재무·조달·운영의 8개 Agent는 자신의 endpoint와 공식문서 corpus를 유지합니다. Core는 부서 원문을 직접 소유하지 않고 질의 정제, 역할 선택, evidence plan, 응답 통합, 감사 추적만 담당합니다.</p><div className="noveltyGrid"><section><b>Department identity</b><p>역할·문서소유권·endpoint가 실행마다 바뀌지 않습니다.</p></section><section><b>Local authority</b><p>변환과 요약은 근거 소유부서에서 수행합니다.</p></section><section><b>Canonical evidence</b><p>원문 대신 canonical ID와 evidence handle로 인용을 추적합니다.</p></section><section><b>Backward compatibility</b><p>기존 API와 legacy 실행모드를 그대로 유지합니다.</p></section></div></div></article>

      <article><span className="aboutNumber">03</span><div><h2>실행 흐름</h2><ol><li><b>질의 정제</b><span>직접 식별자를 제거하고 목적·민감도·필수 coverage를 추출합니다.</span></li><li><b>Role routing</b><span>PGRF와 boundary-constrained router가 필요한 부서만 선택합니다.</span></li><li><b>Local retrieval</b><span>각 Agent가 자신의 canonical corpus에서 후보 근거를 검색합니다.</span></li><li><b>Evidence planning</b><span>raw·sanitized·local-summary·metadata-only를 정책과 비용으로 평가합니다.</span></li><li><b>Gateway delivery</b><span>고정 Evidence Gateway와 network proxy를 거쳐 최소 근거를 전달합니다.</span></li></ol></div></article>

      <article><span className="aboutNumber">04</span><div><h2>SAEA 목적함수와 hard policy</h2><div className="formulaTable"><div><b>Policy</b><code>allow(level, mode, owner, requester, zone)</code><p>personal raw와 비소유부서 confidential raw를 차단합니다.</p></div><div><b>Coverage</b><code>matched required concepts / required concepts</code><p>역할별 threshold 미달 근거는 선택하지 않습니다.</p></div><div><b>Sensitivity</b><code>cross-boundary bytes × level weight</code><p>public 1, internal 2, confidential 5, personal 8의 가중치를 적용합니다.</p></div><div><b>Network</b><code>latency + bytes / bandwidth + local transform</code><p>지연·대역폭·loss·owner overload 시나리오를 반영합니다.</p></div></div><p className="researchClaim">실현 가능한 선택이 없으면 정책을 우회하지 않고 human review로 escalation합니다.</p></div></article>

      <article><span className="aboutNumber">05</span><div><h2>실제 HTTP 실험 구조</h2><p>비교실험은 함수 호출을 네트워크처럼 계산한 것이 아니라 고정 endpoint의 Evidence Gateway와 application-layer proxy를 실제 HTTP로 통과시켰습니다. normal, interdepartmental, low-bandwidth, lossy, owner-overload, mixed 여섯 시나리오에 deterministic delay·bandwidth·loss를 주입했습니다.</p><ul className="metricList"><li><b>Evidence completion</b><span>선택된 역할이 정책 허용 근거와 필수 coverage를 모두 확보한 비율</span></li><li><b>Policy violation</b><span>hard policy를 위반해 경계를 넘은 evidence decision 비율</span></li><li><b>Raw boundary bytes</b><span>부서 경계를 넘은 raw content payload byte</span></li><li><b>Weighted boundary bytes</b><span>민감도 weight를 적용한 전체 경계 이동량</span></li><li><b>P95 latency</b><span>query-method cluster 안에서 계산한 empirical P95</span></li><li><b>Mode distribution</b><span>네 evidence mode의 선택 빈도와 scenario별 변화</span></li></ul></div></article>

      <article><span className="aboutNumber">06</span><div><h2>비교군과 ablation</h2><p>Raw central, always local, fixed sanitized, network only, security only, oracle feasible을 SAEA와 같은 HTTP 환경에서 비교합니다. Policy·coverage·sensitivity·network 항을 하나씩 제거한 ablation과 weighted scalarization도 별도로 실행합니다. Router 연구에는 static, top-k, threshold, learned, cost-aware와 MasRouter·RouteLLM-MF·IRT-Router adapter를 포함합니다.</p></div></article>

      <article><span className="aboutNumber">07</span><div><h2>검증된 성과</h2><p>AXNetCC-SAEA는 main study에서 policy violation 0, evidence completion 0.860을 달성하며 oracle-feasible 0.861에 근접했습니다. 40-query 확장 검증에서도 policy violation 0을 유지했고, Router는 macro-F1 0.665로 비교군 최고 성능을 기록했습니다. Qwen·Llama·Gemma·OpenAI 교차검증과 전체 raw trace까지 제공해 결과의 투명성과 후속 확장성을 동시에 확보했습니다.</p></div></article>
    </section>

    <footer><span>AXNetCC v2 · Security-Aware Evidence Acquisition</span><div className="footerLinks"><Link href="/evaluation">평가 결과</Link><Link href="/">실행 화면</Link></div></footer>
  </main>;
}
