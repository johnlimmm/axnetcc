from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[1]
p=root/'monitor/public/index.html'
s=p.read_text(encoding='utf8')
s=s.replace('MNC <b>MONITOR</b><small>OPERATIONS CONSOLE</small>', 'MNC <b>LAB</b><small>KOREA UNIVERSITY · AXNetCC</small>')
s=s.replace('<a href="/distributed" data-page="distributed"><span>◈</span>분산 실행 평가</a>', '<a href="/evaluation" data-page="evaluation"><span>◈</span>실행 평가</a>')
import re
s=re.sub(r'<a href="/distributed" data-page="distributed">.*?</a>', '<a href="/evaluation" data-page="evaluation"><span>◈</span>실행 평가</a>', s)
s=re.sub(r'<a href="/benchmarks" data-page="benchmarks">.*?</a>', '', s)
p.write_text(s,encoding='utf8')
shutil.copyfile(root/'outputs/lab-template/image1.png',root/'monitor/public/lab-template-strip.png')
p=root/'monitor/server.mjs';s=p.read_text(encoding='utf8')
s=s.replace('implementation, readBenchmarks }','implementation, readBenchmarks, readRoutingBenchmark }')
s=s.replace('if (url.pathname === "/api/benchmarks")', 'if (url.pathname === "/api/routing-benchmark") { send(await readRoutingBenchmark()); return; }\n      if (url.pathname === "/api/benchmarks")')
s=s.replace('const assets = { ', 'const assets = { "/evaluation": ["index.html", "text/html"], "/lab-template-strip.png": ["lab-template-strip.png", "image/png"], ')
p.write_text(s,encoding='utf8')
p=root/'monitor/public/app.js';s=p.read_text(encoding='utf8')
s=s.replace('"/distributed": "distributed"','"/evaluation": "evaluation", "/distributed": "evaluation"').replace('"/benchmarks": "benchmarks"','"/benchmarks": "evaluation"')
s=s.replace('descriptions.distributed = ["분산 실행 · 성능 비교", "TTFT·TPOT·토큰 생성률과 네트워크 연결시간을 조건·기법별로 비교합니다."];','descriptions.evaluation = ["실행 평가", "Agent 라우팅의 선택 품질과 호출량을 비교하고, 저장된 실험 결과를 확인합니다."];')
s=s.replace('page === "distributed"','page === "evaluation"').replace('page === "benchmarks"','page === "evaluation"')
s=s.replace('let completionData = null;', 'let completionData = null, routingData = null;\nlet evaluationSource = new URLSearchParams(location.search).get("source") ?? "routing";')
s=s.replace("if (event.target.id === 'campaign-scenario')", "if (event.target.id === 'evaluation-source') { evaluationSource = event.target.value; render(); }\n  if (event.target.id === 'campaign-scenario')")
s=s.replace('$("content").innerHTML = distributedView();','$("content").innerHTML = evaluationView();')
s=s.replace('const reportResponse = await fetch("/api/benchmarks", { signal });', 'const routingResponse = await fetch("/api/routing-benchmark", { signal });\n      routingData = routingResponse.ok ? await routingResponse.json() : { status: "unavailable" };\n      const reportResponse = await fetch("/api/benchmarks", { signal });')
for old,new in {'#70dfb3':'#8f171a','#73a8ff':'#1f4e79','#e08c94':'#b34a32','#e8b879':'#956522','#c0a3ee':'#6d2aa6','#f38d94':'#777b80','#7ed3e1':'#287d78'}.items():s=s.replace(old,new)
p.write_text(s,encoding='utf8')
