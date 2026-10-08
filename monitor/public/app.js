const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const numeric = value => typeof value === "number" && Number.isFinite(value);
const count = value => numeric(value) ? value.toLocaleString("ko-KR") : "—";
const ms = value => !numeric(value) ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)}초` : `${value.toFixed(0)}ms`;
const percent = value => numeric(value) ? `${(value * 100).toFixed(1)}%` : "—";
const time = value => numeric(value) ? new Date(value).toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const date = value => numeric(value) ? new Date(value).toLocaleString("ko-KR", { hour12: false }) : "—";
const statuses = { running: "실행 중", integrating: "통합 중", completed: "완료", partial_failed: "일부 실패", failed: "실패", cancelled: "취소", interrupted: "관측 중단" };
const agents = { tech: "기술", data: "데이터", security: "보안", legal: "법률", policy: "정책", finance: "재무", procurement: "조달", operations: "운영" };
const modes = { proposed: "제안 방식", managed: "Managed", parallel: "전체 병렬", centralized: "중앙집중형", masrouter: "MasRouter", remoterag: "RemoteRAG" };
const page = ({ "/evaluation": "evaluation", "/distributed": "evaluation", "/runs": "runs", "/implementation": "implementation", "/benchmarks": "evaluation", "/feedback": "feedback" })[location.pathname] ?? "overview";
const descriptions = { overview: ["서비스 모니터링", "독립 수집기가 기록한 실행 지표와 서비스 상태를 모니터링합니다."], runs: ["실행 기록", "서비스와 별도로 저장한 실행별 지연 시간, 상태, 생성 방식입니다."], implementation: ["구현 현황", "현재 구현 범위와 수집 구조를 운영 관점에서 확인합니다."], benchmarks: ["고정 벤치마크", "보관된 평가 보고서입니다. 실시간 운영 지표와 별도로 해석하세요."] };
descriptions.evaluation = ["실행 평가", "Agent 라우팅의 선택 품질과 호출량을 비교하고, 저장된 실험 결과를 확인합니다."];
descriptions.feedback = ["수집된 피드백", "사용자가 남긴 만족도와 개선 의견을 운영 콘솔에서 확인합니다."];
$("page-title").textContent = descriptions[page][0]; $("page-description").textContent = descriptions[page][1];
document.querySelector(`[data-page="${page}"]`).setAttribute("aria-current", "page");
document.title = `${descriptions[page][0]} | MNC Monitor`;
if (page === "implementation" || page === "evaluation") { document.querySelector(".filters").hidden = true; $("export").hidden = true; }
if (page === "feedback") { document.querySelector(".filters > div").hidden = true; $("export").hidden = true; }
const initialParams = new URLSearchParams(location.search);
for (const key of ["window", "mode", "backend"]) if ([...$(key).options].some(option => option.value === initialParams.get(key))) $(key).value = initialParams.get(key);
let data = null, timer, controller, benchmarkData = null, openedLinkedRun = false;
let feedbackData = null, feedbackError = false;
let completionData = null, routingData = null;
let evaluationSource = new URLSearchParams(location.search).get("source") ?? "routing";
let selectedExecution = null;
let networkData = null;
let campaignData = null, nativeLogData = null;
let selectedCampaignScenario = 'healthy', selectedCampaignMetric = 'p50Ms';
document.addEventListener('change', event => {
  if (event.target.id === 'evaluation-source') { evaluationSource = event.target.value; render(); }
  if (event.target.id === 'campaign-scenario') { selectedCampaignScenario = event.target.value; render(); }
  if (event.target.id === 'campaign-metric') { selectedCampaignMetric = event.target.value; render(); }
});
const feedbackCategories = { accuracy: "답변 정확성", evidence: "근거와 출처", latency: "응답 속도", usability: "화면 사용성", other: "기타" };
const filterParams = () => new URLSearchParams({ window: $("window").value, mode: $("mode").value, backend: $("backend").value });
const metric = (label, value, detail, accent = false) => `<article class="metric ${accent ? "accent" : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;
const pill = status => `<span class="pill ${esc(status)}">${esc(statuses[status] ?? status)}</span>`;
const emptyChart = () => `<div class="chartEmpty">선택 기간에 측정된 실행이 없습니다.<small>응답 서비스에 요청이 들어오면 자동으로 수집합니다.</small></div>`;

function chart(series, kind) {
  const points = series.filter(item => kind !== "latency" || numeric(item.p95));
  if (!points.length) return emptyChart();
  const width = 740, height = 215, left = 53, right = 16, top = 14, bottom = 30;
  const from = data.range.from, to = data.range.to;
  const max = Math.max(1, ...points.map(item => kind === "latency" ? item.p95 / 1000 : item.count)) * 1.2;
  const x = at => left + (at - from) / (to - from) * (width - left - right);
  const y = value => height - bottom - value / max * (height - top - bottom);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind === "latency" ? "완료 실행의 E2E P50 및 P95 추이" : "시간 구간별 종료 요청 건수"}">`;
  for (let i = 0; i <= 4; i++) {
    const value = max * i / 4;
    svg += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left - 8}" y="${y(value) + 4}" text-anchor="end">${kind === "latency" ? value.toFixed(0) + "s" : value.toFixed(0)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const at = from + (to - from) * i / 4;
    const label = to - from > 86_400_000 ? new Date(at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" }) : time(at).slice(0, 5);
    svg += `<text x="${x(at)}" y="${height - 4}" text-anchor="middle">${esc(label)}</text>`;
  }
  if (kind === "latency") {
    for (const [key, color] of [["p50", "#8f171a"], ["p95", "#1f4e79"]]) {
      let path = "", previous = null;
      for (const point of points) {
        if (!numeric(point[key])) continue;
        path += `${previous !== null && point.at - previous < Math.max(120000, (to - from) / 25) ? "L" : "M"}${x(point.at)},${y(point[key] / 1000)} `;
        previous = point.at;
      }
      svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
      for (const point of points) if (numeric(point[key])) svg += `<circle cx="${x(point.at)}" cy="${y(point[key] / 1000)}" r="3.5" fill="${color}"><title>${esc(date(point.at))} ${key.toUpperCase()}: ${esc(ms(point[key]))}</title></circle>`;
    }
  } else {
    for (const point of points) svg += `<rect x="${x(point.at)}" y="${y(point.count)}" width="8" height="${height - bottom - y(point.count)}" rx="2" fill="${point.errors ? "#b34a32" : "#8f171a"}"><title>${esc(date(point.at))}: 종료 ${point.count}건 / 오류 ${point.errors}건</title></rect>`;
  }
  return `<div class="chart">${svg}</svg></div>`;
}

function runTable(rows) {
  if (!rows.length) return `<div class="emptyState">수집된 실행이 없습니다. 서비스 요청이 완료되면 이곳에 자동으로 기록됩니다.</div>`;
  return `<div class="tableWrap"><table><thead><tr><th>실행 ID / 시작 시각</th><th>방식</th><th>상태</th><th>생성</th><th>E2E</th><th>TTFT</th><th>TPOT</th><th>토큰</th></tr></thead><tbody>${rows.map(run => `<tr><td><button class="runLink" data-run="${esc(run.runId)}" data-instance="${esc(run.instanceId)}">${esc(run.runId)}</button><br><small>${esc(date(run.startedAt))}</small></td><td>${esc(modes[run.mode] ?? run.mode)}</td><td>${pill(run.status)}</td><td>${esc(run.backend ?? "—")}</td><td>${esc(ms(run.metrics.latencyMs))}</td><td>${esc(ms(run.metrics.ttftMs))}</td><td>${esc(ms(run.metrics.tpotMs))}</td><td>${esc(count(run.metrics.tokens))}</td></tr>`).join("")}</tbody></table></div>`;
}

function overview(stale) {
  const t = data.totals, health = data.collector.latest?.health;
  const healthStale = stale || !health || Date.now() - health.observedAt > 65_000;
  const cards = metric("진행 중 · 전체 방식", stale ? "—" : count(data.collector.latest?.active), stale ? "최신 상태를 확인할 수 없음" : "서비스 전체 실행 수", true)
    + metric("E2E · P95", ms(t.e2eP95), `계측 ${t.e2eSamples}건 · P50 ${ms(t.e2eP50)}`, true)
    + metric("평균 TTFT", ms(t.ttft), `평균 TPOT ${ms(t.tpot)}`)
    + metric("종료 처리량", data.sampleSeries.length ? `${t.throughputPerMinute.toFixed(2)}/분` : "—", `선택 기간 종료 ${t.runs}건`)
    + metric("요청 오류율", percent(t.errorRate), `실패·일부 실패 ${t.errors}건 / 종료 ${t.runs}건`)
    + metric("규칙 기반 대체", count(t.fallback), `Agent 또는 통합 단계의 대체 응답`);
  const grid = Object.entries(agents).map(([id, name]) => {
    const live = health?.agents.find(agent => agent.id === id), history = data.agents.find(agent => agent.id === id);
    const label = healthStale || !live ? "확인 불가" : live.transport === "remote" ? live.connected ? "설정 확인" : "설정 오류" : live.connected ? "연결됨" : "연결 안 됨";
    return `<article class="agent"><div><strong>${name} Agent</strong><span class="status ${healthStale || !live?.connected || live.transport === "remote" ? "unknown" : ""}">${label}</span></div><small>호출 ${history?.calls ?? 0}회 · P95 ${ms(history?.p95)}</small></article>`;
  }).join("");
  return `<section class="metricsGrid" aria-label="핵심 성능 지표">${cards}</section>
    <div class="chartGrid"><section class="panel"><div class="panelHead"><div><h2>응답 지연 시간 추이</h2><p>완료·일부 실패 실행의 구간별 계측값 · 빈 구간은 연결하지 않음</p></div><div class="legend"><span>P50</span><span>P95</span></div></div>${chart(data.series, "latency")}</section><section class="panel"><div class="panelHead"><div><h2>종료 요청 추이</h2><p>시간 구간별 종료 건수 · 붉은 막대는 오류 포함</p></div></div>${chart(data.series, "count")}</section></div>
    <section class="panel"><div class="panelHead"><div><h2>Agent 및 작업 대기열</h2><p>전체 서비스의 현재 상태 · Agent별 호출·P95는 선택 기간과 필터 적용</p></div><span class="healthLabel">${healthStale ? "상태 미확인" : `${time(health.observedAt)} 확인`}</span></div><div class="agentGrid">${grid}</div><div class="runtimeStats"><span>대기 작업<b>${healthStale ? "—" : count(health.scheduler.queueDepth)}</b></span><span>실행 작업<b>${healthStale ? "—" : count(health.scheduler.activeCount)}</b></span><span>최장 대기<b>${healthStale ? "—" : ms(health.scheduler.oldestWaitMs)}</b></span><span>관측 중단<b>${t.interrupted}건</b></span></div><p class="methodNote">원격 Edge의 ‘설정 확인’은 네트워크 연결 성공을 뜻하지 않습니다. 상태가 오래되면 연결 여부를 표시하지 않습니다.</p></section>
    <section class="panel sectionSpace"><div class="panelHead"><div><h2>최근 실행</h2><p>실행 ID를 선택하면 수집된 지표 상세를 확인할 수 있습니다.</p></div><a href="/runs" class="button secondary">전체 기록 →</a></div>${runTable(data.runs.slice(0, 8))}</section>
    <p class="methodNote">처리량 = 수집된 종료 건수 ÷ 선택 기간(분). 오류율 = 실패·일부 실패 ÷ 종료 건수(취소 포함). 관측 중단은 오류율에서 제외합니다. 지연 백분위는 실제 값이 있는 완료·일부 실패 실행만 사용합니다. 미측정은 —이며 0으로 대체하지 않습니다.</p>`;
}

function implementationView() {
  return `<section class="architecture" aria-label="수집 구조"><div><span>01 / SERVICE</span><strong>응답 서비스</strong><small>업무 요청·생성·피드백</small></div><div><span>02 / TELEMETRY API</span><strong>지표만 노출</strong><small>실행 상태·토큰·시간</small></div><div><span>03 / COLLECTOR</span><strong>독립 프로세스</strong><small>${data.config.intervalMs / 1000}초 주기로 자동 수집</small></div><div><span>04 / STORAGE</span><strong>별도 SQLite</strong><small>${data.config.retentionDays}일 보관·콘솔 재시작 후 유지</small></div></section><section class="panel"><div class="panelHead"><div><h2>구현 목록 <span class="readOnlyTag">문서 기준 · 수동 관리</span></h2><p>${esc(data.implementation.updatedAt)} 업데이트. 아래 목록은 기능 설명이며 자동 테스트나 배포 성공의 실시간 판정이 아닙니다.</p></div></div><div class="tableWrap"><table class="implementationTable"><thead><tr><th>기능</th><th>구현 범위</th><th>내용</th></tr></thead><tbody>${data.implementation.features.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section><section class="panel sectionSpace"><h2>보관과 장애 처리</h2><p class="methodNote">수집기는 콘솔 서버 프로세스에서 동작합니다. 브라우저를 닫아도 수집을 계속하며, 콘솔 서버를 종료하면 수집이 중단됩니다. 서비스 지표 버퍼는 완료 후 최대 24시간·10,000건이며, 재연결 시 남아 있는 기록을 가져옵니다. 수집 전 서비스가 재시작되면 해당 메모리 기록은 복구할 수 없습니다. 지표 버퍼 유실 또는 서비스 재시작은 콘솔에 별도로 표시합니다.</p><p class="methodNote">현재 수집원: ${esc(data.config.serviceUrl)} · 수집기 시작: ${date(data.config.startedAt)} · 관측한 서비스 재시작: ${data.collector.sourceRestarts}회</p></section>`;
}

function evaluationView() {
  const options = [['routing','Agent 라우팅 비교'],['longitudinal','로컬 반복 실행'],['reports','저장된 평가 보고서'],['distributed','분산 실행 측정 기록']];
  const source = options.some(([id]) => id === evaluationSource) ? evaluationSource : 'routing';
  return `<section class="evaluationPicker"><label>실험 선택 <select id="evaluation-source">${options.map(([id,label]) => `<option value="${id}" ${source === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span>서로 다른 실행 조건은 합산하지 않습니다.</span></section>` +
    (source === 'routing' ? routingBenchmarkView() : source === 'longitudinal' ? longitudinalView() : source === 'reports' ? benchmarkView() : distributedView());
}

function paperBars(rows, key, label, unit, ceiling = null) {
  const width = 900, height = 330, left = 65, right = 25, top = 35, bottom = 78;
  const maximum = ceiling ?? Math.max(1, ...rows.filter(row => numeric(row[key])).map(row => row[key])) * 1.2;
  const y = value => height-bottom-value/maximum*(height-top-bottom);
  const step = (width-left-right)/Math.max(1,rows.length);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} (${esc(unit)})"><text x="${left}" y="18">${esc(unit)}</text>`;
  for(let i=0;i<=4;i++) { const v=maximum*i/4; svg+=`<line x1="${left}" x2="${width-right}" y1="${y(v)}" y2="${y(v)}" stroke="#dfe3e8"/><text x="${left-10}" y="${y(v)+5}" text-anchor="end">${v.toFixed(maximum>10?0:1)}</text>`; }
  rows.forEach((row,i) => {
    const x=left+step*(i+.5), value=row[key], proposed=/proposed/i.test(row.method ?? row.mode ?? '');
    if(numeric(value)) svg+=`<rect x="${x-step*.27}" y="${y(value)}" width="${step*.54}" height="${height-bottom-y(value)}" fill="${proposed?'#8f171a':'#85898e'}"/><text x="${x}" y="${y(value)-10}" text-anchor="middle" class="figureValue">${value.toFixed(key==='decisionTimeMedianMs'?3:2)}</text>`;
    else svg+=`<text x="${x}" y="${y(0)-10}" text-anchor="middle">미측정</text>`;
    const name=String(row.label ?? modes[row.mode] ?? row.mode ?? row.method ?? '미분류');
    svg+=`<text x="${x}" y="${height-bottom+25}" text-anchor="middle">${esc(name.replace('Proposed adaptive hybrid','Proposed').replace('v2 boundary heuristic','v2 heuristic'))}</text>`;
  });
  return `<figure class="paperFigure" data-metric="${esc(key)}"><figcaption>${esc(label)}</figcaption>${svg}</svg><div class="figureDownloads"><button type="button" data-chart-export="svg">SVG 다운로드</button><button type="button" data-chart-export="png">PNG 다운로드</button><span role="status"></span></div></figure>`;
}

function presentationSvg(figure) {
  const source = figure.querySelector('svg').cloneNode(true);
  source.setAttribute('xmlns','http://www.w3.org/2000/svg');
  source.setAttribute('width','900'); source.setAttribute('height','410');
  source.setAttribute('viewBox','0 0 900 410');
  const ns='http://www.w3.org/2000/svg';
  const elements=[...source.childNodes];
  const group=document.createElementNS(ns,'g'); group.setAttribute('transform','translate(0 45)');
  elements.forEach(node=>group.appendChild(node)); source.appendChild(group);
  const bg=document.createElementNS(ns,'rect');
  for(const [key,value] of Object.entries({width:900,height:410,fill:'#ffffff'})) bg.setAttribute(key,value);
  source.insertBefore(bg,group);
  const title=document.createElementNS(ns,'text'); title.setAttribute('x','30');title.setAttribute('y','29');
  title.setAttribute('font-weight','700');title.setAttribute('font-size','20');
  title.textContent=figure.querySelector('figcaption').textContent;source.appendChild(title);
  const note=document.createElementNS(ns,'text'); note.setAttribute('x','30');note.setAttribute('y','395');
  note.setAttribute('font-size','12');
  note.textContent=evaluationSource==='longitudinal' && longitudinalData
    ? `${longitudinalData.status} · ${longitudinalData.sampleCount} executions · ${longitudinalData.updatedAt}`
    : `Development dataset · ${routingData?.generatedAt ?? ''}`;
  source.appendChild(note);
  source.querySelectorAll('text').forEach(text=>{
    text.setAttribute('font-family','Arial, Malgun Gothic, sans-serif');text.setAttribute('fill','#20252b');
    if(!text.hasAttribute('font-size'))text.setAttribute('font-size','15');
    if(text.classList.contains('figureValue'))text.setAttribute('font-weight','700');
  });
  return new XMLSerializer().serializeToString(source);
}

async function downloadChart(button) {
  const figure=button.closest('.paperFigure'), status=figure.querySelector('[role=status]');
  button.disabled=true;status.textContent='다운로드 준비 중';
  let url;
  try {
    const svg=presentationSvg(figure), format=button.dataset.chartExport;
    let blob=new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
    if(format==='png') {
      await document.fonts.ready;
      const image=new Image(), source='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
      try {
        await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=source;});
        const canvas=document.createElement('canvas');canvas.width=2700;canvas.height=1230;
        canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
        blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if(!blob)throw new Error('PNG 생성 실패');
      } finally {image.src='';}
    }
    url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;
    link.download=`evaluation-${figure.dataset.metric}-${new Date().toISOString().slice(0,10)}.${format}`;
    link.click();status.textContent='다운로드 완료';
  } catch(error) {status.textContent='다운로드 실패 · 다시 시도해 주세요';console.error(error);}
  finally {button.disabled=false;if(url)setTimeout(()=>URL.revokeObjectURL(url),10000);}
}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-chart-export]');
  if(button)void downloadChart(button);
});

function routingBenchmarkView() {
  if(routingData?.status !== 'ready') return '<div class="emptyState">라우팅 평가 보고서를 사용할 수 없습니다.</div>';
  const rows=routingData.rows;
  return `<section class="panel"><div class="panelHead"><h2>Agent 선택 품질과 호출량</h2><span class="readOnlyTag">개발셋 ${count(routingData.dataset.cases)}문항 · 저장된 결과</span></div><p class="methodNote">동일 질의의 Agent 선택을 비교합니다. 개발 데이터 평가이며 독립 검증 결과가 아닙니다. CPU 시간에는 검색·LLM·네트워크가 포함되지 않고, 제안 방식의 근거 coverage는 미리 계산합니다. 답변 품질이나 전체 응답시간의 우위를 의미하지 않습니다.</p><div class="paperGrid">${paperBars(rows,'macroF1','(a) Agent 선택 Macro F1','%',100)}${paperBars(rows,'criticalRoleRecall','(b) 필수 검토 역할 Recall','%',100)}${paperBars(rows,'averageFanOut','(c) 평균 선택 Agent 수','agents')}${paperBars(rows,'decisionTimeMedianMs','(d) 라우팅 정책 CPU 시간 · 중앙값','ms')}</div><p class="methodNote">기록 시각 ${esc(routingData.generatedAt)} · 오차 막대는 저장된 불확실성 추정치가 없어 표시하지 않습니다. <a href="/api/routing-benchmark">원본 집계 JSON</a></p></section>`;
}

let longitudinalData = null;
function longitudinalView() {
  if(!longitudinalData?.rows?.length) return `<section class="panel"><h2>로컬 반복 실행</h2><p class="methodNote">${esc(longitudinalData?.status ?? '준비 중')} · 실제 실행 결과가 저장되면 표시합니다.</p></section>`;
  const r=longitudinalData;
  return `<section class="panel"><div class="panelHead"><h2>로컬 실제 LLM 실행 · 반복 측정</h2><span class="readOnlyTag">${esc(r.status)} · ${count(r.sampleCount)}건</span></div><p class="methodNote">동일 PC·모델·질의별 모드 순서 무작위화·요청 동시성 1. 개발 질의 반복으로 안정성을 측정하며 독립 정답률 검증은 아닙니다. completed는의미적 정답이 아닙니다. 지연·호출·토큰은 대체 없는 LLM 완료만 집계하며 Agent F1은 전체 완료 기준입니다. 기법별 호출 구조가 다릅니다. TTFT는 요청에 참여한 제공자의 최솟값, TPOT·생성률은 제공자 평균을 요청별로 집계합니다. 정답 사실 충족률은 별도 12문항의 규칙 판정으로 전체 의미 정확도와 구분합니다.</p><div class="paperGrid">${paperBars(r.rows,'latencyMs','(a) E2E Latency','ms')}${paperBars(r.rows,'ttftMs','(b) 요청별 최소 제공자 TTFT · 평균','ms')}${paperBars(r.rows,'tpotMs','(c) 요청별 평균 제공자 TPOT · 평균','ms/token')}${paperBars(r.rows,'tokensPerSecond','(d) 요청별 평균 제공자 Token throughput','token/s')}${paperBars(r.rows,'factCoverage','(e) 정답 사실 충족률 · 규칙 판정','%',100)}${paperBars(r.rows,'agentF1','(f) Agent 선택 평균 F1','%',100)}${paperBars(r.rows,'calls','(g) 평균 LLM 호출 수','calls')}${paperBars(r.rows,'tokens','(h) 평균 생성 토큰','tokens')}</div><div class="tableWrap"><table><thead><tr><th>방식</th><th>완료 / 전체</th><th>실제 LLM 완료</th><th>완전 계측</th><th>대체 응답</th><th>토큰 계측 표본</th><th>고유 질의</th><th>평균 E2E</th></tr></thead><tbody>${r.rows.map(row=>`<tr><td>${esc(modes[row.mode] ?? row.mode)}</td><td>${row.completed}/${row.n}</td><td>${row.realLlmCompleted}</td><td>${count(row.validSamples)}</td><td>${row.fallback}</td><td>${count(row.measuredTokenSamples)}</td><td>${row.uniqueQueries}</td><td>${ms(row.latencyMs)}</td></tr>`).join('')}</tbody></table></div><p class="methodNote">같은 질의 반복을 독립 표본으로 취급하지 않습니다. 원시 결과·질의별 집계와 실행 설정은 로컬 실험 폴더에 저장됩니다. 기법·질의별 완전 계측 3회 이상과 E2E 변동 기준을 충족하면 종료합니다. <a href="/api/longitudinal">진행 결과 JSON</a></p></section>`;
}

function benchmarkView() {
  if (!benchmarkData) return `<div class="emptyState">고정 평가 보고서를 불러오는 중입니다.</div>`;
  return `<div class="benchmarkGrid">${benchmarkData.map(report => `<section class="panel"><div class="panelHead"><h2>${esc(report.title)}</h2><span class="readOnlyTag">${esc(report.status)}</span></div><p class="benchmarkMeta">기록된 실행 ${count(report.completedRuns)}회 · ${esc(report.file)} · ${esc(report.generatedAt ?? "시각 미기록")}</p>${report.rows.length ? `<div class="tableWrap"><table><thead><tr><th>방식</th><th>표본</th><th>품질</th><th>E2E</th><th>TTFT</th><th>TPOT</th><th>Privacy Risk v2</th><th>전송량</th></tr></thead><tbody>${report.rows.map(row => `<tr><td>${esc(modes[row.mode] ?? row.mode)}</td><td>${count(row.n)}</td><td>${numeric(row.quality) ? row.quality.toFixed(1) : "—"}</td><td>${ms(row.latencyMs)}</td><td>${ms(row.ttftMs)}</td><td>${ms(row.tpotMs)}</td><td>${numeric(row.privacyRisk) ? row.privacyRisk.toFixed(1) : "—"}</td><td>${count(row.boundaryBytes)} B</td></tr>`).join("")}</tbody></table></div>` : `<div class="emptyState">사용 가능한 v2 측정 결과가 없습니다.</div>`}<p class="methodNote">미측정 값은 —로 표시합니다. 보고서의 실험 조건과 생성 환경을 기준으로 해석하세요. 운영 실행 추이에 합산하지 않습니다.</p></section>`).join("")}</div>`;
}

function feedbackView() {
  if (feedbackError) return `<section class="panel"><h2>피드백 저장소에 연결하지 못했습니다.</h2><p class="methodNote">저장소 경로와 접근 권한을 확인한 뒤 새로고침해 주세요. 조회 실패를 0건으로 표시하지 않습니다.</p></section>`;
  if (!feedbackData) return `<div class="emptyState">피드백을 불러오는 중입니다.</div>`;
  const f = feedbackData;
  return `<section class="feedbackMetricGrid">${metric("전체 피드백", `${count(f.total)}건`, "피드백 저장소 전체 기간")}${metric("평균 만족도", f.averageRating === null ? "—" : `${f.averageRating.toFixed(1)} / 5`, "사용자 평가 · 자동 품질 점수와 별도", true)}</section>
    <div class="feedbackSummaryGrid"><section class="panel"><h2>만족도 분포</h2><div class="ratingDistribution">${[5,4,3,2,1].map(rating => `<div><strong>${rating}점</strong><progress max="${Math.max(1, f.total)}" value="${f.ratings[rating] ?? 0}" aria-label="${rating}점 ${f.ratings[rating] ?? 0}건"></progress><span>${count(f.ratings[rating] ?? 0)}건</span></div>`).join("")}</div></section><section class="panel"><h2>개선 요청 항목</h2><div class="feedbackCategoryList">${Object.entries(feedbackCategories).map(([key,label]) => `<div><span>${label}</span><b>${count(f.categories[key] ?? 0)}건</b></div>`).join("")}</div><p class="methodNote">여러 항목을 함께 선택할 수 있습니다.</p></section></div>
    <section class="panel sectionSpace"><div class="panelHead"><div><h2>최근 의견</h2><p>최근 50건 · 사용자 서비스에서는 의견 작성과 접수 확인만 제공합니다.</p></div><span class="readOnlyTag">운영자 조회</span></div><div class="collectedFeedback">${f.recent.length ? f.recent.map(record => `<article><header><strong>${record.rating} / 5점</strong><time datetime="${esc(record.createdAt)}">${esc(new Date(record.createdAt).toLocaleString("ko-KR"))}</time></header><p>${esc(record.comment || "별점만 남긴 피드백입니다.")}</p><div class="feedbackTags">${record.categories.map(key => `<span>${esc(feedbackCategories[key] ?? key)}</span>`).join("")}</div>${record.runId ? `<a class="feedbackRunLink" href="${esc(new URL(`/?run=${encodeURIComponent(record.runId)}`, data.config.serviceUrl).href)}" target="_blank" rel="noopener noreferrer">연결된 응답 ${esc(record.runId)} ↗</a>` : `<small>서비스 전반에 대한 의견</small>`}</article>`).join("") : `<div class="emptyState">아직 접수된 피드백이 없습니다. 서비스에서 의견을 제출하면 여기에 표시됩니다.</div>`}</div></section>`;
}

function render() {
  const latest = data.collector.latest, lastSuccess = data.collector.lastSuccessAt;
  const stale = !latest?.ok || !lastSuccess || Date.now() - lastSuccess > Math.max(15_000, data.config.intervalMs * 3);
  $("connection").textContent = stale ? "수집원 연결 끊김" : "LIVE · 수집 중"; $("connection").className = `connection ${stale ? "stale" : ""}`;
  $("last-update").textContent = `최근 수집 ${date(lastSuccess)}`;
  $("collector-dot").className = `dot ${stale ? "" : "live"}`; $("collector-label").textContent = stale ? "수집원 재연결 대기" : "독립 수집기 동작 중";
  $("collector-interval").textContent = `${data.config.intervalMs / 1000}초 수집 · ${data.config.retentionDays}일 보관`;
  $("service-link").href = data.config.serviceUrl;
  const notices = [];
  if (stale) notices.push("서비스의 최신 상태를 가져오지 못했습니다. 기존 수집 기록은 유지되며 자동으로 재연결합니다.");
  if (data.collector.lastGapAt >= data.range.from) notices.push("수집 공백 동안 서비스의 지표 버퍼 일부가 유실되었습니다. 표시된 통계는 수집된 표본 기준입니다.");
  if (data.totals.interrupted) notices.push(`서비스 재시작으로 ${data.totals.interrupted}건의 완료 여부를 확인할 수 없습니다.`);
  $("notice").hidden = !notices.length; $("notice").textContent = notices.join(" ");
  $("export").href = `${page === "evaluation" ? "/api/attempts.csv" : "/api/export.csv"}?${filterParams()}`;
  $("content").innerHTML = page === "overview" ? overview(stale) : page === "runs" ? `<section class="panel"><div class="panelHead"><div><h2>수집된 실행 · 최근 200건</h2><p>모니터링 저장소의 기록입니다. 서비스가 재시작되어도 수집 완료된 지표는 남습니다.</p></div></div>${runTable(data.runs)}</section>` : page === "implementation" ? implementationView() : benchmarkView();
  if (page === "feedback") $("content").innerHTML = feedbackView();
  if (page === "evaluation") $("content").innerHTML = evaluationView();
  if (!openedLinkedRun && initialParams.get("run")) {
    const run = data.runs.find(run => run.runId === initialParams.get("run"));
    if (run) { openedLinkedRun = true; void showRun(run.instanceId, run.runId); }
  }
}

async function showRun(instance, id) {
  const response = await fetch(`/api/run?instance=${encodeURIComponent(instance)}&run=${encodeURIComponent(id)}`);
  if (!response.ok) { $("notice").hidden = false; $("notice").textContent = "이 실행의 저장된 지표를 찾을 수 없습니다."; return; }
  const run = await response.json();
  $("dialog-title").textContent = run.runId;
  const metrics = [["E2E", "latencyMs", ms], ["TTFT", "ttftMs", ms], ["TPOT", "tpotMs", ms], ["Queue wait", "queueWaitMs", ms], ["Inference", "inferenceMs", ms], ["Token", "tokens", count], ["LLM 호출", "calls", count], ["경계 전송량 · B", "boundaryBytes", count], ["Privacy Risk v2", "privacyRiskScore", count], ["S · 민감정보 전달", "sensitiveTransmissionRatio", percent], ["A · Agent 선택", "agentSelectionRatio", percent], ["O · 원문 전달", "originalDisclosureRatio", percent], ["산출 품질 점수", "qualityScore", count], ["인용 Coverage", "citationCoverage", count], ["인용 유효성", "citationValidity", count], ["인용 Recall", "citationRecall", count], ["검색 성공률", "retrievalSuccessRate", count], ["답변 완결성", "answerCompleteness", count]];
  $("run-detail").innerHTML = `<p class="detailMeta">${pill(run.status)} · ${esc(modes[run.mode] ?? run.mode)} · ${esc(run.model ?? "모델 미기록")}<br>${date(run.startedAt)} → ${date(run.completedAt)}</p><div class="detailMetrics">${metrics.map(([label, key, format]) => metric(label, format(run.metrics[key]), run.provenance[key] ?? "unavailable")).join("")}</div><p class="methodNote">TTFT·TPOT는 참여 모델 계측의 집계입니다. 브라우저에 첫 글자가 표시되는 시간을 의미하지 않습니다. 이 저장소에는 요청·응답 본문과 근거 내용이 없습니다.</p><div class="detailActions"><a class="button" target="_blank" rel="noopener noreferrer" href="${esc(new URL(`/?run=${encodeURIComponent(run.runId)}`, data.config.serviceUrl).href)}">서비스에서 응답 보기 ↗</a></div><p class="methodNote">서비스의 응답 기록은 별도로 만료될 수 있습니다. 모니터링 지표의 보관 기간과 다릅니다.</p>`;
  if (!$("run-dialog").open) $("run-dialog").showModal();
}

async function load() {
  clearTimeout(timer); controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  $("refresh").disabled = true;
  try {
    const response = await fetch(`/api/summary?${filterParams()}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error("MONITOR_READ_FAILED");
    const next = await response.json();
    if (page === "evaluation") {
      try { const r = await fetch('/api/longitudinal', { signal, cache:'no-store' }); longitudinalData = r.ok ? await r.json() : { status:'unavailable',rows:[] }; } catch { if(signal.aborted) return; longitudinalData = { status:'unavailable',rows:[] }; }
      try {
        const evidence = await fetch("/api/completion", { signal, cache: "no-store" });
        if (!evidence.ok) throw new Error("COMPLETION_READ_FAILED");
        completionData = await evidence.json();
      } catch (error) { if (signal.aborted) throw error; completionData = { status: "unavailable", bindingVerified: false }; }
      try {
        const network = await fetch("/api/network", { signal, cache: "no-store" });
        if (!network.ok) throw new Error("NETWORK_READ_FAILED");
        networkData = await network.json();
      } catch (error) { if (signal.aborted) throw error; networkData = { error: "unavailable" }; }
      for (const [path, assign] of [['/api/campaign', value => { campaignData = value; }], ['/api/execution-logs', value => { nativeLogData = value; }]]) {
        try {
          const response = await fetch(path, { signal, cache: 'no-store' });
          if (!response.ok) throw new Error('SHOWCASE_READ_FAILED');
          assign(await response.json());
        } catch (error) { if (signal.aborted) throw error; assign({ status: 'unavailable' }); }
      }
    }
    if (page === "feedback") {
      try {
        const feedbackResponse = await fetch("/api/feedback", { signal, cache: "no-store" });
        if (!feedbackResponse.ok) throw new Error("FEEDBACK_READ_FAILED");
        feedbackData = await feedbackResponse.json(); feedbackError = false;
      } catch (error) { if (signal.aborted) throw error; feedbackError = true; }
    }
    if (page === "evaluation" && !benchmarkData) {
      const routingResponse = await fetch("/api/routing-benchmark", { signal });
      routingData = routingResponse.ok ? await routingResponse.json() : { status: "unavailable" };
      const reportResponse = await fetch("/api/benchmarks", { signal });
      if (!reportResponse.ok) throw new Error("BENCHMARK_READ_FAILED");
      benchmarkData = await reportResponse.json();
    }
    if (signal.aborted) return;
    data = next; render();
  } catch {
    if (signal.aborted) return;
    $("notice").hidden = false; $("notice").textContent = "모니터링 콘솔에 연결하지 못했습니다. 콘솔 서버 상태를 확인해 주세요. 화면의 이전 기록은 최신 상태가 아닙니다.";
    $("connection").textContent = "콘솔 조회 실패"; $("connection").className = "connection stale";
  } finally {
    if (!signal.aborted) { $("refresh").disabled = false; if ($("auto").checked) timer = setTimeout(load, data?.config.intervalMs ?? 5000); }
  }
}
for (const key of ["window", "mode", "backend"]) $(key).addEventListener("change", () => { history.replaceState(null, "", `${location.pathname}?${filterParams()}`); void load(); });
$("auto").addEventListener("change", () => { if ($("auto").checked) void load(); else clearTimeout(timer); });
$("refresh").addEventListener("click", () => void load());
$("close-dialog").addEventListener("click", () => $("run-dialog").close());
$("content").addEventListener("click", event => { const button = event.target.closest("[data-run]"); if (button) void showRun(button.dataset.instance, button.dataset.run); });
$("content").addEventListener("change", event => {
  if (event.target.id === "execution-run") { selectedExecution = event.target.value; render(); }
});
void load();

function completionGateView() {
  if (completionData?.bindingVerified) {
    const evidence = completionData;
    const gateLabels = { passed: "통과", failed: "실패", pending: "미평가" };
    const latency = value => value === "Infinity" ? "∞ · 최종 응답 미확인 포함" : ms(value);
    const gateBadge = key => `<span class="evidenceGate ${esc(evidence.gates[key])}">${esc(key)} · ${esc(gateLabels[evidence.gates[key]] ?? "미확인")}</span>`;
    return `<section class="panel acceptanceGate" data-testid="completion-gates"><div class="panelHead"><div><h2>현재 완성본 수락 평가</h2><p>고정된 40 + 10건 · 동시 3건 · 첫 시도 기준</p></div><span class="readOnlyTag">아티팩트·평가 연결 검증됨</span></div><p class="methodNote">이 검증은 파일 해시와 평가 연결을 확인합니다. 자동 의미 검증이나 전체 데모 완료 판정이 아닙니다. 의미 검토: ${esc(evidence.semanticReview)} · 수집 ${count(evidence.admitted)} / 50건 · 배포 ${esc(evidence.deploymentId)} · 동결 ${esc(evidence.frozenAt)}</p><div class="acceptanceTargets"><div>${gateBadge("Q1")}<strong>${count(evidence.quality.answerablePassed)} / 40</strong><span>목표 ≥ 36 · 사실/출처/질문 충족 모두 통과</span></div><div>${gateBadge("Q2")}<strong>${count(evidence.quality.safetyPassed)} / 10</strong><span>목표 10 · 혼합 6 / 근거 부족 4</span></div><div>${gateBadge("Q3")}<strong>사용자에게 표시된 주장</strong><span>Agent·최종 답변의 안전한 주장 검토</span></div><div>${gateBadge("P1")}<strong>${latency(evidence.latency.finalResponseP95Ms)}</strong><span>최종 응답 P95 · 목표 ≤ 60초</span></div></div><p class="methodNote">전체 종료 P95 ${latency(evidence.latency.allTerminalP95Ms)} · 종료 관측 ${count(evidence.latency.terminalObserved)} / 40 · 최종 응답 미확인/기한 초과 ${count(evidence.latency.censoredFinalCount)} / 40. 미응답은 ∞로 유지합니다. 최근 운영 통계와 합산하지 않습니다. 준비 조건: ${esc(evidence.readiness)}.</p><div class="acceptanceRoles" aria-label="역할별 5문항 평가">${Object.entries(evidence.roleScores).map(([role, score]) => `<span><b>${esc(agents[role] ?? role)}</b> ${count(score.passed)} / 5</span>`).join("")}</div><p class="methodNote">동결 설정 Edge: ${esc(evidence.renderingConfiguration?.edge ?? "미기록")} / Core: ${esc(evidence.renderingConfiguration?.core ?? "미기록")}. 호출별 관측이 아니며 Edge 복제본 설정 일치는 별도 배포 증적이 필요합니다. 최종 답변 렌더링: 모델 안내 발췌 ${count(evidence.outcomes.extractive)} / 근거 기반 생성 ${count(evidence.outcomes.generated)} / 미확인 ${count(evidence.outcomes.renderingUnknown)}. 분류는 동결 설정 기준이며 의미적 정확성의 증거가 아닙니다. 실제 추론 기록 ${count(evidence.outcomes.realInference)}건, 유용한 답변 ${count(evidence.outcomes.useful)}건.</p><aside class="remainingEvidence"><strong>전체 완료는 아직 증명되지 않았습니다</strong><p>D 분산 장애·복구 / M 계측 / U 서비스 사용성 / V 최종 검증은 별도 증적이 필요합니다. Q1·Q2·Q3·P1 통과만으로 이를 승인하지 않습니다.</p></aside><details class="evidenceHashes"><summary>평가 재현을 위한 배포·모델·설정 해시</summary><p class="methodNote">모델·빌드·설정 해시는 동결 매니페스트의 식별자입니다. 실행 중인 원격 배포와의 일치는 별도 배포 증적이 필요합니다. 로컬 경로·질문·평가 원문·비밀 설정은 노출하지 않습니다.</p><dl>${Object.entries(evidence.hashes).map(([key, hash]) => `<dt>${esc(key)}</dt><dd>${esc(hash ?? "미기록")}</dd>`).join("")}${evidence.artifacts.map(artifact => `<dt>${esc(artifact.kind)} artifact</dt><dd>${esc(artifact.sha256)}</dd>`).join("")}</dl></details><a class="button secondary" href="/api/completion/report.json">검증 결과 JSON 다운로드 · 민감 필드 제외</a></section>`;
  }
  const invalid = ["invalid", "unavailable"].includes(completionData?.status);
  const warning = invalid ? '<p class="completionError" role="alert">평가 보고서를 읽거나 연결을 검증하지 못했습니다. 이전 통과 결과를 표시하지 않습니다.</p>' : "";
  return `<section class="panel acceptanceGate" data-testid="completion-gates"><div class="panelHead"><div><h2>현재 완성본 수락 평가</h2><p>새 질문 · 동일 배포 버전 · 독립 의미 검토</p></div><span class="readOnlyTag">평가 보고서 미연결</span></div>${warning}<div class="acceptanceTargets"><div><strong>36 / 40 이상</strong><span>답변 가능 질문 · 사실/출처/질문 충족 모두 통과</span></div><div><strong>10 / 10</strong><span>혼합·근거 부족 질문의 안전한 처리</span></div><div><strong>P95 ≤ 60초</strong><span>동시 3건 · 첫 40건 · 대기와 실패 포함</span></div></div><p class="methodNote">위 숫자는 목표이며 달성 실측값이 아닙니다. 현재 수집 지표나 과거 WATCH 파일럿은 이 평가를 대체하지 않습니다. 모델 추론 성공과 의미적 정답은 다릅니다. 최종 평가는 독립 AI-assisted 검토와 원시 기록을 함께 확인해야 합니다.</p></section>`;
}

function distributedCallDetails(run) {
  const d = run.distributed;
  const unknown = value => numeric(value) ? count(value) : "미측정";
  const labels = { agent: "Agent", core: "Core", onlineVerification: "온라인 검증/수정", evaluation: "평가" };
  return `<section class="callDetails" aria-label="추론 호출과 비용 구분"><h3>호출별 Core·검증·평가 사용량</h3><p class="methodNote">${d.callDetail === "per-call" ? "개별 호출 ID로 기록합니다. 동일 단계의 여러 호출도 각각 포함합니다." : "과거 단계별 기록: 개별 호출 이력은 확인할 수 없습니다."} 외부 평가 사용량은 이 기록에 없을 수 있으며, 기록 없음은 비용 0의 증거가 아닙니다.</p><div class="tableWrap"><table><caption>개별 추론 호출 · Agent 물리 시도는 위 표에 별도 표시</caption><thead><tr><th>호출 ID / 단계</th><th>모델 / backend</th><th>입력 / 출력 토큰</th></tr></thead><tbody>${(d.calls ?? []).map(call => `<tr><td>${esc(call.callId)}<br>${esc(call.stage)}</td><td>${esc(call.model ?? "미확인")} / ${esc(call.backend ?? "미확인")}</td><td>${unknown(call.promptTokens)} / ${unknown(call.completionTokens)}</td></tr>`).join("") || '<tr><td colspan="3">개별 호출 기록 없음</td></tr>'}</tbody></table></div><div class="costCategories">${Object.entries(d.usageByCategory ?? {}).map(([key, usage]) => `<p><strong>${esc(labels[key] ?? key)}</strong> 기록 ${count(usage.inferenceCount)}건 · 전체 ${unknown(usage.promptTokens)} / ${unknown(usage.completionTokens)} · 알려진 소계 ${count(usage.knownPromptTokens)} / ${count(usage.knownCompletionTokens)}</p>`).join("")}</div><a class="button secondary" href="/api/run?instance=${encodeURIComponent(run.instanceId)}&run=${encodeURIComponent(run.runId)}" target="_blank" rel="noopener noreferrer">이 실행 원시 JSON ↗</a></section>`;
}

function observedTopology(runs) {
  const paths = new Map();
  for (const run of runs) for (const attempt of run.distributed.attempts) {
    const key = `${run.distributed.deploymentId ?? "unclassified"}:${attempt.agentId}`;
    if (!paths.has(key)) paths.set(key, { agent: attempt.agentId, deployment: run.distributed.deploymentId, primary: new Set(), backup: new Set() });
    paths.get(key)[attempt.role === "backup" ? "backup" : "primary"].add(attempt.nodeId);
  }
  return `<section class="panel sectionSpace"><h2>관측된 역할별 분산 경로</h2><p class="methodNote">실제 수집된 시도의 노드 ID만 표시합니다. 미관측 백업은 없음이 아니라 미확인입니다. 연결 상태·물리 호스트 독립성·서버 전원 장애를 이 그림만으로 증명하지 않습니다.</p><div class="observedPaths">${[...paths.values()].map(path => `<article><strong>${esc(agents[path.agent] ?? path.agent)} Agent</strong><small>${esc(path.deployment ?? "배치 미분류")}</small><p>Core → 주 노드 <b>${esc([...path.primary].join(", ") || "미관측")}</b></p><p>↳ 백업 <b>${esc([...path.backup].join(", ") || "미관측")}</b></p></article>`).join("")}</div></section>`;
}

function performanceChart(samples, key, label, unit) {
  const groups = new Map();
  for (const sample of samples) {
    if (!numeric(sample.at)) continue;
    const name = `${sample.deploymentId ?? 'unclassified'} / ${sample.nodeId} / ${sample.agentId} (${sample.kind})`;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(sample);
  }
  const measured = samples.filter(sample => numeric(sample.at) && numeric(sample[key]));
  if (!measured.length) return `<div class="chartEmpty">${esc(label)} 미측정<small>제공자 계측이 없는 표본은 0으로 채우지 않습니다.</small></div>`;
  const width = 740, height = 215, left = 62, right = 16, top = 16, bottom = 30;
  const from = data.range.from, to = Math.max(from + 1, data.range.to);
  const max = Math.max(1, ...measured.map(sample => sample[key])) * 1.15;
  const x = at => left + (at-from)/(to-from)*(width-left-right);
  const y = value => height-bottom-value/max*(height-top-bottom);
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)} 노드별 추이 (${esc(unit)})">`;
  for (let i=0; i<=4; i++) {
    const value = max*i/4;
    svg += `<line x1="${left}" x2="${width-right}" y1="${y(value)}" y2="${y(value)}"/><text x="${left-8}" y="${y(value)+4}" text-anchor="end">${esc(value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }))}</text>`;
    const at = from+(to-from)*i/4;
    const tick = to-from > 86400000 ? new Date(at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : time(at);
    svg += `<text x="${x(at)}" y="${height-4}" text-anchor="middle">${esc(tick)}</text>`;
  }
  const colors = ['#8f171a', '#1f4e79', '#956522', '#6d2aa6', '#777b80', '#287d78'];
  let legend = '', index = 0;
  for (const [name, points] of groups) {
    const color = colors[index++ % colors.length];
    let path = '', previous = null, count = 0;
    for (const point of points.sort((a,b) => a.at-b.at)) {
      if (!numeric(point[key])) { previous = null; continue; }
      path += `${previous === null ? 'M' : 'L'}${x(point.at)},${y(point[key])} `;
      previous = point.at; count++;
      svg += `<circle cx="${x(point.at)}" cy="${y(point[key])}" r="4" fill="${color}"><title>${esc(name)} · ${esc(point.runId)} · ${esc(point.id)} · ${esc(date(point.at))}: ${point[key].toFixed(2)} ${esc(unit)} · ${esc(point.status)}</title></circle>`;
    }
    if (!count) continue;
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
    legend += `<span style="border-color:${color}">${esc(name)} · ${count}개</span>`;
  }
  return `<div class="chart">${svg}</svg></div><div class="performanceLegend">${legend}</div>`;
}

function distributedPerformanceView(summary) {
  const samples = summary.performance ?? [];
  const metrics = [['ttftMs', '제공자 TTFT', 'ms'], ['tpotMs', '제공자 TPOT', 'ms/token'], ['tokensPerSecond', '생성 Token throughput', 'token/s'], ['elapsedMs', 'Agent 시도 / 중앙 호출 지연', 'ms'], ['requestBytesPrepared', '요청 준비 본문', 'B'], ['responseBytesReceived', '응답 수신 본문', 'B']];
  return `<section class="panel sectionSpace" data-testid="distributed-performance"><h2>노드별 추론 성능 · 애플리케이션 전송량</h2><p class="methodNote">선택 기간의 수집 표본 ${count(samples.length)}개. Agent 시도와 중앙 추론 호출을 노드·역할·배치별로 분리합니다. TTFT·TPOT는 제공자 모델 계측이며 token/s는 측정 TPOT의 역수로 계산한 생성 속도입니다. 사용자 응답 첫 토큰 시각이나 KOREN 망 대역폭을 뜻하지 않습니다. 시도 지연에는 대기·전송·추론이 포함될 수 있습니다. 준비·수신 본문 바이트는 NIC 트래픽, RTT, 패킷 손실을 측정하지 않습니다. 미측정은 그래프 공백으로 유지합니다.</p><div class="performanceGrid">${metrics.map(([key,label,unit]) => `<section><h3>${label} <small>${unit}</small></h3>${performanceChart(samples, key, label, unit)}</section>`).join('')}</div></section>`;
}

function networkPerformanceView() {
  const note = '모니터 서버 → 설정 대상 TCP 연결 시간입니다. HTTP 응답·모델 추론 지연과 분리하며 ICMP RTT, 패킷 손실, 링크 대역폭을 측정하지 않습니다. 연결 성공은 KOREN 경로 통과의 증거가 아닙니다. 실행 ID에 연결되지 않은 독립 탐침이며 노드별 최근 120개 중 선택 기간에 속한 표본만 표시합니다.';
  if (!networkData || networkData.error) return `<section class="panel sectionSpace" data-testid="network-performance"><h2>네트워크 TCP 탐침</h2><p class="methodNote">탐침 조회 ${networkData?.error ? '실패' : '중'} · 미측정을 0으로 표시하지 않습니다.</p></section>`;
  if (!networkData.targets?.length) return `<section class="panel sectionSpace" data-testid="network-performance"><h2>네트워크 TCP 탐침 · 미설정</h2><p class="methodNote">MONITOR_NETWORK_TARGETS에 관측할 노드와 TCP 포트를 설정하면 연결 시간 그래프를 수집합니다. ${note}</p></section>`;
  if (networkData.semantics !== 'tcp-connect') return `<section class="panel sectionSpace"><h2>네트워크 탐침 계측 형식 미확인</h2></section>`;
  const samples = networkData.targets.flatMap(target => (target.samples ?? []).filter(sample => numeric(sample.timestamp) && sample.timestamp >= data.range.from && sample.timestamp <= data.range.to).map(sample => ({ at: sample.timestamp, elapsedMs: sample.success && numeric(sample.connectMs) ? sample.connectMs : null, nodeId: target.nodeId, agentId: 'TCP connect', kind: 'probe', runId: 'independent-probe', id: target.nodeId, status: sample.success ? 'connected' : 'failed' })));
  return `<section class="panel sectionSpace" data-testid="network-performance"><h2>네트워크 TCP 연결 시간</h2><p class="methodNote">${note}</p>${performanceChart(samples, 'elapsedMs', 'TCP 연결 시간', 'ms')}<div class="performanceLegend">${networkData.targets.map(target => {
    const readings = (target.samples ?? []).filter(sample => numeric(sample.timestamp) && sample.timestamp >= data.range.from && sample.timestamp <= data.range.to);
    const success = readings.filter(sample => sample.success === true).length;
    return `<span>${esc(target.nodeId)} · 연결 성공 ${success}/${readings.length} (${percent(readings.length ? success/readings.length : null)}) · 실패 ${readings.length-success}</span>`;
  }).join('')}</div></section>`;
}

function executionLogsView(runs, summary) {
  if (!runs.length) return '';
  const identity = run => `${run.instanceId}/${run.runId}`;
  const run = runs.find(run => identity(run) === selectedExecution) ?? runs[0];
  const events = summary.executionLogs?.find(log => log.runId === run.runId && log.instanceId === run.instanceId)?.events ?? [];
  const groups = new Map([['중앙 오케스트레이터', events.filter(event => event.lane === 'central')]]);
  for (const event of events.filter(event => event.lane === 'node')) {
    const name = `노드 ${event.nodeId}`;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(event);
  }
  const stamp = at => new Date(at).toISOString();
  return `<section class="panel sectionSpace" data-testid="distributed-execution-logs"><div class="panelHead"><h2>같은 실행의 중앙 · 노드 이벤트 로그</h2><label class="executionSelect">실행 <select id="execution-run">${runs.map(item => `<option value="${esc(identity(item))}" ${identity(item) === identity(run) ? 'selected' : ''}>${esc(item.runId)} / ${esc(item.instanceId)}</option>`).join('')}</select></label></div><p class="methodNote">출처: central-observed. 같은 run ID와 중앙 서비스 시계로 재구성한 시도·호출 이벤트입니다. 노드 프로세스의 native stdout이나 노드 자체 시계 로그가 아닙니다. 중앙에서 응답으로 관측한 설정 노드 ID는 실제 KOREN 경로 통과나 물리 호스트 독립성을 증명하지 않습니다. 자동 갱신은 수집 주기를 따릅니다.</p><p class="logRunIdentity">${esc(run.instanceId)} / ${esc(run.runId)} · ${pill(run.status)} · UTC</p><div class="executionLogGrid">${[...groups].map(([name, items]) => `<section><h3>${esc(name)}</h3><ol>${items.map(event => `<li><time datetime="${stamp(event.at)}">${stamp(event.at)} <b>+${((event.at-run.startedAt)/1000).toFixed(3)}s</b></time><code>${esc(event.id)}</code><span>${esc(event.message)}</span><small>central-observed${event.nodeId ? ` · ${esc(event.nodeId)}` : ''}</small></li>`).join('') || '<li>관측된 이벤트 없음</li>'}</ol></section>`).join('')}</div></section>`;
}

function nativeExecutionView() {
  if (!nativeLogData || nativeLogData.status !== 'ready') return `<section class="panel sectionSpace"><h2>실제 노드 프로세스 로그</h2><p class="methodNote">${nativeLogData?.status === 'missing' ? '전용 SSH 로그 수집기 미연결' : '로그 수집 조회 중 또는 실패'} · 중앙에서 재구성한 이벤트로 대체하지 않습니다.</p></section>`;
  const request = selectedExecution?.split('/').at(-1);
  const events = (nativeLogData.events ?? []).filter(event => !request || event.requestId === request).sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0,300);
  const hosts = [...new Set(events.map(event => event.host))];
  const stale = !numeric(nativeLogData.updatedAt) || Date.now()-nativeLogData.updatedAt > 15000;
  return `<section class="panel sectionSpace nativeLogs" data-testid="native-execution-logs"><div class="panelHead"><h2>실제 중앙 · 분산 노드 stdout</h2><span class="readOnlyTag">${stale ? '수집 지연' : '자동 수집'} · ${esc(date(nativeLogData.updatedAt))}</span></div><p class="methodNote">SSH로 각 서버의 전용 프로세스 stdout JSON을 수집합니다. host는 로그를 생성한 서버입니다. ${request ? `선택 요청 ${esc(request)}` : '최근 요청 전체 · 아래 실행 선택에서 같은 요청만 볼 수 있습니다.'} · 최신 이벤트부터 표시하며 서버 시계가 동기화되어 있다는 전제의 정렬입니다.</p><div class="executionLogGrid">${hosts.map(host => `<section><h3>${esc(host)} · ${host === 'hpc' ? '중앙 오케스트레이션' : host === 'mnckoren' ? '주 Agent 노드' : host === 'ai-cloud' ? '백업 Agent 노드' : '실행 노드'}</h3><ol>${events.filter(event => event.host === host).map(event => `<li class="nativeLogEntry"><time>${esc(event.timestamp)}</time><strong>${esc(event.event)}</strong><span>${esc(event.agentId ?? 'Core')} · ${esc(event.status ?? '수신')} · ${esc(ms(event.elapsedMs))}</span><code>${esc(event.requestId)}</code><small>node ${esc(event.nodeId ?? '—')} / replica ${esc(event.replicaId ?? '—')}<br>${esc(event.attemptId ?? '')}</small></li>`).join('')}</ol></section>`).join('') || '<p>선택 요청의 실제 프로세스 로그가 아직 없습니다.</p>'}</div></section>`;
}

function campaignComparisonView() {
  if (!campaignData || campaignData.status !== 'ready') return `<section class="panel sectionSpace"><h2>비교기법 · 시나리오 실측</h2><p class="methodNote">${campaignData?.status === 'missing' ? '실험 보고서 미연결' : '보고서 조회 중 또는 실패'} · 과거/모의 결과로 채우지 않습니다.</p></section>`;
  const labels = { healthy:'정상', 'primary-delay-300':'주 경로 300ms 주입', 'primary-down':'주 경로 불가', 'both-down':'양쪽 경로 불가', 'restored-primary':'주 경로 복구' };
  const metrics = { p50Ms:['종료 지연 P50','ms'],p95Ms:['종료 지연 P95','ms'],ttftMs:['평균 제공자 TTFT','ms'],tpotMs:['평균 제공자 TPOT','ms/token'],tokensPerSecond:['평균 생성 처리율','token/s'],requestBytes:['평균 Agent 요청 준비 본문','B'],responseBytes:['평균 Agent 응답 수신 본문','B'],tcpConnectMs:['평균 독립 TCP 연결시간','ms'] };
  const scenarios = [...new Set((campaignData.groups ?? []).map(group => group.scenario))];
  const scenario = scenarios.includes(selectedCampaignScenario) ? selectedCampaignScenario : scenarios[0];
  const key = Object.hasOwn(metrics, selectedCampaignMetric) ? selectedCampaignMetric : 'p50Ms';
  const rows = (campaignData.groups ?? []).filter(group => group.scenario === scenario);
  const maximum = Math.max(1, ...rows.filter(row => numeric(row[key])).map(row => row[key]));
  const manifest = campaignData.manifest ?? {};
  return `<section class="panel sectionSpace" data-testid="campaign-comparison"><div class="panelHead"><h2>비교기법 × 시나리오 · 실제 실험</h2><span class="readOnlyTag">${esc(manifest.state ?? '관측 중')} · ${count(manifest.sampleCount)} / ${count(manifest.plannedCount)}건</span></div><p class="methodNote">${esc(manifest.deploymentId)} · 동일 공개 질의와 모델 · 순차 요청 1건 · 셀별 표본 수를 함께 확인하세요. 실패·부분 실패도 종료 지연과 분모에 포함합니다. TTFT/TPOT/생성률은 기록된 참여 제공자 호출의 평균이며 사용자 첫 출력이나 망 대역폭이 아닙니다. 300ms는 gateway 애플리케이션 지연 주입입니다. TCP는 HPC에서 SSH 포트로 수행한 별도 탐침입니다. 작은 표본의 P95를 일반적인 성능 보장으로 해석하지 마세요. 추론 완료는 의미적 정답을 뜻하지 않습니다. MasRouter·RemoteRAG는 inspired 구현입니다.</p><div class="campaignControls"><label>시나리오 <select id="campaign-scenario">${scenarios.map(value => `<option value="${esc(value)}" ${value === scenario ? 'selected' : ''}>${esc(labels[value] ?? value)}</option>`).join('')}</select></label><label>지표 <select id="campaign-metric">${Object.entries(metrics).map(([value,[label,unit]]) => `<option value="${value}" ${value === key ? 'selected' : ''}>${label} (${unit})</option>`).join('')}</select></label></div><div class="comparisonBars" role="img" aria-label="${esc(metrics[key][0])} 비교">${rows.map(row => `<div><strong>${esc(modes[row.method] ?? row.method)}</strong><span class="comparisonTrack"><i style="width:${numeric(row[key]) ? Math.max(0,row[key]/maximum*100) : 0}%"></i></span><span>${numeric(row[key]) ? row[key].toFixed(2) : '미측정'} ${esc(metrics[key][1])}<small>n=${row.count} · LLM 완료 ${row.successCount}/${row.count} · 측정 ${key.startsWith('p') ? row.coverage?.elapsedMs ?? '—' : row.coverage?.[key] ?? '—'}/${row.count}</small></span></div>`).join('')}</div><p class="methodNote">장애 설정 복구 확인: ${manifest.faultRestored ? '확인됨' : '진행 중/미확인'}. <a href="/api/campaign" target="_blank" rel="noopener noreferrer">비교 계측 JSON</a></p></section>`;
}

function distributedView() {
  const executionDetails = new URLSearchParams(location.search).get('execution') === '1';
  const summary = data.distributed;
  if (!summary || !summary.observedRuns) return campaignComparisonView() + (executionDetails ? nativeExecutionView() : '') + completionGateView() + networkPerformanceView() + `<section class="panel" data-testid="distributed-empty"><h2>분산 실행 기록이 없습니다</h2><p class="methodNote">새 분산 계측이 포함된 실행만 표시합니다. 과거·모의 벤치마크는 별도 보고서에서 확인하세요. 누락된 사용량을 0으로 채우지 않습니다.</p></section>`;
  const totals = summary.totals;
  const runs = data.runs.filter(run => run.distributed);
  const counter = value => value === null ? "미측정" : count(value);
  return `<div data-testid="distributed-evaluation">${completionGateView()}<div class="detailActions exportActions"><a class="button secondary" href="/api/attempts.csv?${filterParams()}">Agent 시도 CSV</a><a class="button secondary" href="/api/calls.csv?${filterParams()}">Core·검증·평가 호출 CSV</a></div>
    <section class="metricGrid">${metric("전체 종료 요청", count(summary.allTerminal.count), `실패·취소 포함 / 시간 표본 ${summary.allTerminal.timingSamples}`)}${metric("실제 LLM 완료", count(summary.finalizedRealSuccess.count), `완료 요청 중 모든 채택 Agent가 LLM / ${percent(summary.realSuccessRate)}`, true)}${metric("전체 종료 P50 / P95", `${ms(summary.allTerminal.p50)} / ${ms(summary.allTerminal.p95)}`, "응답 지연: 실패·취소 포함")}${metric("LLM 완료 P50 / P95", `${ms(summary.finalizedRealSuccess.p50)} / ${ms(summary.finalizedRealSuccess.p95)}`, `성공 시간 표본 ${summary.finalizedRealSuccess.timingSamples}`)}</section>
    <section class="panel sectionSpace"><div class="panelHead"><h2>LLM 입력·출력 토큰 / 완전성</h2><span class="readOnlyTag">계측 커버리지 ${totals.measuredCount} / ${totals.inferenceCount}</span></div>
      <div class="metricGrid">${metric("완전한 입력 / 출력 합계", `${counter(totals.promptTokens)} / ${counter(totals.completionTokens)}`, "하나라도 불명확하면 전체 합계 미측정")}${metric("알려진 입력 / 출력 소계", `${count(totals.knownPromptTokens)} / ${count(totals.knownCompletionTokens)}`, `미측정 추론 ${totals.unknownCount}건 · 합계가 아닙니다`)}${metric("미채택 시도 토큰 소계", `${count(totals.retryKnownPromptTokens)} / ${count(totals.retryKnownCompletionTokens)}`, "실패·취소·폐기 비용의 알려진 부분")}${metric("LLM 백업 채택", count(summary.adoptedBackupAttempts), "Agent 복구 횟수 · 전체 요청 복구율 아님")}</div>
      <p class="methodNote">실제 LLM 완료는 종료 상태와 추론 backend 기준입니다. 의미적 정답·인용 지지 여부는 별도 고정 워크로드 평가가 필요합니다. 복구율의 분모는 장애 대상 Agent가 선택된 평가 요청에서 산출합니다. 수집 범위 전체 ${summary.observedRuns}건, 구형 계측 제외 ${summary.legacyRunsExcluded}건. 출처: 설정된 데모 ${summary.sourceCounts["configured-demo"]}건 / 미분류 ${summary.sourceCounts.unclassified}건. 서로 다른 배치·워크로드의 인과적 성능 비교로 해석하지 마세요.</p>
    </section>
    ${campaignComparisonView()}
      ${executionDetails ? nativeExecutionView() + observedTopology(runs) : ''}
    ${distributedPerformanceView(summary)}
    ${networkPerformanceView()}
      ${executionDetails ? executionLogsView(runs, summary) : ''}
    <section class="panel sectionSpace"><h2>Agent · 노드별 송수신</h2><div class="tableWrap"><table data-testid="distributed-node-table"><thead><tr><th>노드 / Agent</th><th>시도 / 채택 / 실패</th><th>LLM 입력 토큰 소계</th><th>LLM 출력 토큰 소계</th><th>미측정 시도</th><th>Core→Agent 준비 본문 B</th><th>Agent→Core 수신 본문 B</th></tr></thead><tbody>${summary.nodes.map(row => `<tr><td>${esc(row.nodeId)} / ${esc(agents[row.agentId] ?? row.agentId)}</td><td>${row.attempts} / ${row.adopted} / ${row.failures}</td><td>${count(row.knownPromptTokens)}</td><td>${count(row.knownCompletionTokens)}</td><td>${row.unknownAttempts}</td><td>${count(row.requestBytesPrepared)}</td><td>${count(row.responseBytesReceived)}</td></tr>`).join("")}</tbody></table></div><p class="methodNote">LLM 입력·출력 토큰은 시스템 지시문·검색 근거를 포함한 모델 추론 카운터이며, Core↔Agent 전송 메시지의 토큰 수가 아닙니다. 요청 준비 바이트는 전달·수신 증거가 아닙니다. 응답 수신 바이트는 실제 읽은 본문이며 HTTP/TLS/NIC 오버헤드를 제외합니다. 합계: 준비 ${counter(totals.requestBytesPrepared)} B / 수신 ${counter(totals.responseBytesReceived)} B.</p></section>
    <section ${executionDetails ? "" : "hidden"} class="panel sectionSpace"><h2>주 노드 → 백업 시도 타임라인</h2><p class="methodNote">최근 200개 실행 상세 / 내보내기도 같은 범위. 상단 요약은 선택 기간 전체입니다. 과거 보고서·모의 결과와 자동 병합하지 않습니다.</p>${runs.map(run => `<details class="distributedRun" data-testid="distributed-run" open><summary>${esc(run.runId)} ${pill(run.status)} <small>${esc(run.distributed.deploymentId ?? "배치 미분류")} / ${esc(run.distributed.source)}</small></summary><div class="tableWrap"><table><thead><tr><th>Agent · 역할 → 노드</th><th>시각 / 지연</th><th>대기</th><th>결과 / 이유</th><th>채택</th><th>입력 / 출력 토큰</th><th>모델</th></tr></thead><tbody>${[...run.distributed.attempts].sort((a,b) => a.startedAt-b.startedAt).map(attempt => `<tr class="${attempt.adopted ? "adoptedAttempt" : ""}"><td>${esc(attempt.agentId)} · ${attempt.role === "backup" ? "백업" : "주"} → ${esc(attempt.nodeId)}</td><td>${time(attempt.startedAt)} / ${ms(attempt.elapsedMs)}</td><td>${ms(attempt.queueWaitMs)}</td><td>${esc(attempt.status)}<br><small>${esc(attempt.reasonCode ?? "—")}</small></td><td>${attempt.adopted ? "채택 ✓" : "미채택"}</td><td>${counter(attempt.promptTokens)} / ${counter(attempt.completionTokens)}<br><small>${esc(attempt.usageStatus)}</small></td><td>${esc(attempt.model ?? "미측정")}<br><small>${esc(attempt.backend ?? "미확인")}</small></td></tr>`).join("")}</tbody></table></div><p class="methodNote">중앙 추론 별도: ${run.distributed.stages.map(stage => `${esc(stage.stage)} (${esc(stage.backend)}): ${counter(stage.promptTokens)} / ${counter(stage.completionTokens)}`).join(" · ") || "아직 계측 없음"}</p>${distributedCallDetails(run)}</details>`).join("")}</section>
  </div>`;
}
