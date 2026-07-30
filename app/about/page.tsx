export default function AboutPage() {
  return (
    <main className="aboutPage">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brandMark">M</span>
          <div><strong>MNC FLOW</strong><small>KOREN Distributed AI Governance</small></div>
        </a>
        <a className="aboutLink" href="/">실행 화면으로 돌아가기</a>
      </header>

      <section className="aboutHero">
        <span className="eyebrow">SERVICE & RESEARCH OVERVIEW</span>
        <h1>분산 AI Agent 협력 거버넌스를<br />왜, 어떻게 검증하는가.</h1>
        <p>MNC FLOW는 공공기관과 기업의 원문 데이터를 조직 경계에 보존하면서, 필요한 전문 Agent만 협력시키는 로컬 LLM·RAG 기반 AX 실증 플랫폼입니다.</p>
      </section>

      <section className="aboutContent">
        <article>
          <span className="aboutNumber">01</span>
          <div><h2>배경과 문제</h2><p>중앙집중형 생성형 AI는 여러 부서의 원문을 하나의 플랫폼으로 모으기 쉽습니다. 이 구조는 개인정보·내부자료 반출, 과도한 처리주체 확대, 전문영역별 책임 불명확, 단일 모델 의존 문제를 만듭니다. 반대로 부서별 시스템을 완전히 분리하면 복합 업무를 함께 검토하기 어렵습니다.</p></div>
        </article>
        <article>
          <span className="aboutNumber">02</span>
          <div><h2>목표와 목적</h2><p>목표는 답변 품질을 크게 희생하지 않으면서 원문 이동과 불필요한 Agent 호출을 줄이는 것입니다. 기술·데이터·보안·법률·정책·재무·조달·운영 Agent가 각자의 로컬 LLM과 RAG를 사용하고, Core는 질의에 필요한 Agent만 선택해 최소 결과를 통합합니다.</p></div>
        </article>
        <article>
          <span className="aboutNumber">03</span>
          <div>
            <h2>동작 구조</h2>
            <ol>
              <li><b>질의 정제</b><span>직접 식별자를 마스킹하고 업무 의도를 분석합니다.</span></li>
              <li><b>동적 라우팅</b><span>질의와 역할 키워드가 일치하는 전문 Agent만 선택합니다.</span></li>
              <li><b>Edge RAG</b><span>각 Agent가 자신의 공식문서 인덱스에서 근거를 검색합니다.</span></li>
              <li><b>독립 추론</b><span>Agent별 Ollama 로컬 LLM이 검색 근거만으로 답변합니다.</span></li>
              <li><b>검증·통합</b><span>인용 ID, 데이터 이동, 성능과 응답을 하나의 감사 기록으로 연결합니다.</span></li>
            </ol>
          </div>
        </article>
        <article>
          <span className="aboutNumber">04</span>
          <div>
            <h2>프로젝트의 노블티</h2>
            <div className="noveltyGrid">
              <section><b>선택적 협력</b><p>모든 Agent를 항상 호출하지 않고 질의별로 필요한 전문성만 실행합니다.</p></section>
              <section><b>Agent별 데이터 주권</b><p>각 Agent가 독립 로컬 LLM과 RAG를 사용하고 원문은 Edge에 남깁니다.</p></section>
              <section><b>품질–보호 동시 비교</b><p>동일 질의를 중앙집중형·상용 Supervisor형·전체 병렬형·제안 방식으로 실행합니다.</p></section>
              <section><b>검증 가능한 거버넌스</b><p>답변뿐 아니라 호출 수, 근거 ID, Core 전송 바이트, TTFT·TPOT을 함께 기록합니다.</p></section>
            </div>
            <p className="researchClaim">연구 가설: 동적 Agent 선택과 Edge RAG를 결합하면 최고 품질 방식과 유사한 응답 품질을 유지하면서 Core 전송 바이트와 PII 유출률을 줄일 수 있다.</p>
          </div>
        </article>
        <article>
          <span className="aboutNumber">05</span>
          <div>
            <h2>라이브 실측지표와 계산식</h2>
            <div className="formulaTable">
              <div><b>E2E Latency</b><code>요청 수신 시각 → 최종 통합 완료 시각</code><p>사용자가 전체 결과를 받기까지의 실제 시간입니다.</p></div>
              <div><b>TTFT</b><code>요청 시각 → 최초 출력 토큰 시각</code><p>응답이 시작되기까지 걸린 시간을 측정합니다.</p></div>
              <div><b>TPOT</b><code>모델 출력 소요시간 ÷ 생성 토큰 수</code><p>출력 토큰 하나를 생성하는 평균 시간입니다.</p></div>
              <div><b>Core 전송량</b><code>Core로 전달된 직렬화 payload의 byte 길이</code><p>원문 대신 최소 결과만 이동했는지 직접 측정합니다.</p></div>
              <div><b>PII Leakage</b><code>응답에 남은 금지 식별자 수 ÷ 삽입한 식별자 수</code><p>정답이 알려진 개인정보 주입 시험에서 계산합니다.</p></div>
            </div>
          </div>
        </article>
        <article>
          <span className="aboutNumber">06</span>
          <div>
            <h2>표준 지표 기반 정확도 평가</h2>
            <p>임의의 라이브 질의에는 정답이 없으므로 accuracy를 계산하지 않습니다. 정답 Agent와 정답 근거가 라벨링된 검증셋에서 다음 표준 정보검색·분류 지표를 계산합니다.</p>
            <ul className="metricList">
              <li><b>Agent Precision·Recall·F1</b><span>필요한 전문 Agent를 정확히 선택했는지 평가</span></li>
              <li><b>Required Concept Recall</b><span>답변이 사전 정의된 핵심 개념을 포함하는지 평가</span></li>
              <li><b>Retrieval Recall@K·MRR</b><span>정답 근거가 검색 상위 K개에 포함되는지 평가</span></li>
              <li><b>Privacy Leakage Rate</b><span>삽입한 민감정보와 금지 문자열의 재출력 비율</span></li>
              <li><b>상용 LLM 블라인드 평가</b><span>방식 이름을 숨기고 정확성·근거충실도·완전성을 보조 채점</span></li>
            </ul>
          </div>
        </article>
        <article>
          <span className="aboutNumber">07</span>
          <div><h2>비교 실험</h2><p>네 방식에 동일한 질의·문서·모델 조건을 적용합니다. 최고 품질 방식의 점수를 100%로 두고 제안 방식의 품질 유지율을 계산한 뒤, 호출 수·Core 전송 바이트·PII Leakage Rate·E2E·TTFT·TPOT의 차이를 함께 비교합니다. 핵심 결과 형식은 “품질 유지율은 유사하면서 데이터 이동과 개인정보 유출은 얼마나 감소했는가”입니다.</p></div>
        </article>
      </section>

      <footer><span>MNC Lab. · Korea University</span><a href="/">MNC FLOW 실행 화면 →</a></footer>
    </main>
  );
}
