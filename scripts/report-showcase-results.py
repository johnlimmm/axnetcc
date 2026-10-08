"""Export reproducible tables and an offline chart from collected real observations."""
import csv
import html
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

root = Path(__file__).resolve().parents[1] / 'outputs/showcase-20261008'
report = json.loads((root / 'hpc/campaign.json').read_text(encoding='utf8'))
samples = report['samples']
keys = ['method','scenario','requestId','status','realInference','elapsedMs','ttftMs','tpotMs','tokensPerSecond','requestBytes','responseBytes','tcpConnectMs']
with (root / 'samples.csv').open('w',newline='',encoding='utf-8-sig') as stream:
    writer=csv.DictWriter(stream,fieldnames=keys,extrasaction='ignore');writer.writeheader();writer.writerows(samples)
groups=defaultdict(list)
for row in samples: groups[(row['scenario'],row['method'])].append(row)
def number(value): return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0
def mean(rows,key):
    values=[row[key] for row in rows if number(row.get(key))]
    return sum(values)/len(values) if values else None
def percentile(rows,p):
    values=sorted(row['elapsedMs'] for row in rows if number(row.get('elapsedMs')))
    return values[math.ceil(len(values)*p)-1] if values else None
def fmt(value): return f'{value:.2f}' if number(value) else '미측정'
summary=[]
for (scenario,method),rows in groups.items():
    summary.append(dict(scenario=scenario,method=method,n=len(rows),completed=sum(r['status']=='completed' and r['realInference'] for r in rows),
        p50Ms=percentile(rows,.5),p95Ms=percentile(rows,.95),**{key:mean(rows,key) for key in keys[6:]},
        coverage={key:sum(number(r.get(key)) for r in rows) for key in keys[6:]}))
(root/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
lines=['# 분산 실행 실측 결과','',f"배치: `{report['manifest'].get('deploymentId')}` · 상태: {report['state']} · {len(samples)}건 · 장애 설정 복구: {report.get('faultRestored')}",'',
    'HPC 중앙 오케스트레이터 → mnckoren 주 Agent 8개 / ai-cloud 백업 Agent 8개. 서버 간 데이터 경로는 PC를 경유하지 않습니다.',
    '', '동일 공개 질의 2개, 동시 요청 1개. 각 기법·조건은 n=2이므로 통계적 우월성이나 성능 보장을 의미하지 않습니다. 실패도 종단 지연 분모에 포함합니다. MasRouter·RemoteRAG는 저장소의 inspired 구현입니다.',
    '', 'TTFT/TPOT/token/s는 참여한 추론 제공자 계측의 평균이며 사용자 첫 출력 지연이나 네트워크 대역폭이 아닙니다. TCP 연결 시간은 HPC에서 SSH 포트로 수행한 별도 관측입니다. 300ms는 애플리케이션 gateway 주입 지연입니다. 실제 KOREN 경로/인터페이스 식별은 이 계측만으로 증명되지 않습니다.',
    '', '| 조건 | 기법 | LLM 완료/n | P50 ms | P95 ms | TTFT ms | TPOT ms/token | token/s | TCP ms |','|---|---|---:|---:|---:|---:|---:|---:|---:|']
for row in summary:
    lines.append('| '+ ' | '.join([row['scenario'],row['method'],f"{row['completed']}/{row['n']}",*[fmt(row[k]) for k in ['p50Ms','p95Ms','ttftMs','tpotMs','tokensPerSecond','tcpConnectMs']]])+' |')
lines+=['','실패/부분 실패: '+json.dumps(dict(Counter(row['status'] for row in samples)),ensure_ascii=False),
    '', '의미 정확도는 별도 평가하지 않았습니다. 백업 노드에서 시간 제한이 발생한 결과를 보존했습니다. 미완료 추론은 전용 모델 프로세스 종료·재기동·워밍업 확인 후 다음 표본을 실행했습니다.',
    '', '원본: hpc/campaign-observed.json · 분류 정정본: hpc/campaign.json · 개별 요청: hpc/RUN-*.json · 노드 로그: 각 서버 폴더 · 표본 CSV: samples.csv · 오프라인 그래프: comparison.html.']
(root/'RESULTS.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
sections=[]
for scenario in dict.fromkeys(row['scenario'] for row in summary):
    rows=[r for r in summary if r['scenario']==scenario]
    graphs=[]
    for key,label in [('p50Ms','종단 지연 P50 (ms)'),('ttftMs','평균 제공자 TTFT (ms)'),('tpotMs','평균 제공자 TPOT (ms/token)'),('tokensPerSecond','평균 제공자 생성률 (token/s)'),('tcpConnectMs','TCP 연결 시간 (ms)')]:
        maximum=max([r[key] for r in rows if number(r[key])]+[1])
        bars=[]
        for r in rows:
            width=r[key]/maximum*100 if number(r[key]) else 0
            bars.append(f'<div class="row"><b>{html.escape(r["method"])}</b><span class="track"><i style="width:{width:.2f}%"></i></span><span>{fmt(r[key])} · 완료 {r["completed"]}/{r["n"]}</span></div>')
        graphs.append('<h3>'+label+'</h3>'+''.join(bars))
    sections.append('<section><h2>'+html.escape(scenario)+'</h2>'+''.join(graphs)+'</section>')
page='''<!doctype html><html lang="ko"><meta charset="utf-8"><title>분산 실측 비교</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px;background:#101924;color:#edf3fa}section{padding:24px;margin:24px 0;background:#1b293a;border-radius:12px}.row{display:grid;grid-template-columns:130px 1fr 250px;gap:15px;margin:12px 0}.track{background:#314254}i{display:block;background:#59d2b0;height:20px}p{line-height:1.7}h3{margin-top:32px}</style><h1>분산 실행 실측 비교</h1><p>38개 계획 표본. 기법·조건별 n=2. 실패 포함 종단 지연과 완료율을 함께 읽으세요. TTFT/TPOT/생성률은 제공자 계측 평균이며 네트워크 대역폭이 아닙니다. 300ms는 gateway 애플리케이션 지연이며 TCP 연결 시간은 별도 관측입니다. 의미 정확도와 KOREN 경로 자체는 평가하지 않았습니다.</p>'''+''.join(sections)+'</html>'
(root/'comparison.html').write_text(page,encoding='utf8')
print(json.dumps({'samples':len(samples),'statuses':dict(Counter(r['status'] for r in samples)),'artifacts':str(root),'faultRestored':report.get('faultRestored')}))
