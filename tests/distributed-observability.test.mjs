import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { distributedPerformance, distributedRunEvents, distributedAttemptsCsv, distributedCallsCsv, distributedSummary } from '../monitor/distributed.mjs';

const run = {
  runId: 'RUN-demo', instanceId: 'instance-a', status: 'completed', startedAt: 1000, completedAt: 2000,
  distributed: { deploymentId: 'configured-demo', attempts: [
    { attemptId: 'a1', nodeId: 'node-a', agentId: 'tech', role: 'primary', startedAt: 1100, completedAt: 1400,
      status: 'failed', adopted: false, reasonCode: 'attempt-timeout', elapsedMs: 300, ttftMs: null, tpotMs: null,
      requestBytesPrepared: 120, responseBytesReceived: 0 },
    { attemptId: 'a2', nodeId: 'node-b', agentId: 'tech', role: 'backup', startedAt: 1400, completedAt: 1700,
      status: 'succeeded', adopted: true, elapsedMs: 300, ttftMs: 0, tpotMs: 10, tokensPerSecond: 100,
      requestBytesPrepared: 120, responseBytesReceived: 500 },
  ], calls: [{ callId: 'c1', nodeId: 'core-node', stage: 'synthesis', startedAt: 1750, endedAt: 1950,
    status: 'succeeded', ttftMs: 25, tpotMs: 5, tokensPerSecond: 200, requestBytesPrepared: 600, responseBytesReceived: 800 }], stages: [] },
};
const source = await readFile(new URL('../monitor/public/app.js', import.meta.url), 'utf8');
test('execution proof panels require explicit diagnostic opt-in on the performance page', () => {
  const view = source.slice(source.indexOf('function distributedView()'), source.indexOf('function distributedView()')+14000);
  assert.match(view, /URLSearchParams\(location.search\)\.get\('execution'\) === '1'/);
  assert.match(view, /executionDetails \? nativeExecutionView\(\) \+ observedTopology\(runs\) : ''/);
  assert.match(view, /executionDetails \? executionLogsView\(runs, summary\) : ''/);
  assert.match(view, /executionDetails \? "" : "hidden"/);
});
const functions = source.slice(source.indexOf('function performanceChart('), source.indexOf('function distributedView('));
function browser(extra = {}) {
  const context = {
    numeric: value => typeof value === 'number' && Number.isFinite(value),
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
    count: value => typeof value === 'number' ? String(value) : '—',
    percent: value => typeof value === 'number' ? `${(value*100).toFixed(1)}%` : '—',
    time: value => new Date(value).toISOString().slice(11,19), date: value => new Date(value).toISOString(),
    pill: status => String(status), selectedExecution: null, networkData: null,
    data: { range: { from: 1000, to: 2500 } }, ...extra,
  };
  vm.createContext(context); vm.runInContext(functions, context);
  return context;
}

test('evidence-only transport does not invalidate successful central inference or count empty runs', () => {
  const baseline = structuredClone(run);
  baseline.distributed.attempts = [{ adopted:true, backend:'deterministic', usageStatus:'not-started', status:'succeeded' }];
  baseline.distributed.calls[0].backend = 'ollama';
  baseline.distributed.totals = {};
  assert.equal(distributedSummary([baseline]).finalizedRealSuccess.count, 1);
  baseline.distributed.calls = [];
  assert.equal(distributedSummary([baseline]).finalizedRealSuccess.count, 0);
});

test('native stdout view filters the selected request, escapes values, and preserves host identity', () => {
  const context = browser({ selectedExecution:'instance-a/RUN-selected', ms:String,
    nativeLogData:{status:'ready',updatedAt:Date.now(),events:[
      {host:'hpc',requestId:'RUN-selected',timestamp:'2026-10-08T00:00:00Z',event:'<script>',agentId:'Core'},
      {host:'ai-cloud',requestId:'RUN-selected',timestamp:'2026-10-08T00:00:01Z',event:'edge-completed',agentId:'tech'},
      {host:'mnckoren',requestId:'RUN-other',timestamp:'2026-10-08T00:00:02Z',event:'hidden-request'},
    ]} });
  const html = context.nativeExecutionView();
  assert.match(html,/hpc/); assert.match(html,/ai-cloud/); assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|hidden-request|RUN-other/);
});

test('comparison renders zero measurements, missing coverage, and failure denominators separately', () => {
  const context = browser({selectedCampaignScenario:'healthy', selectedCampaignMetric:'ttftMs', modes:{},
    campaignData:{status:'ready',manifest:{sampleCount:2,plannedCount:38,state:'running'},groups:[
      {method:'proposed',scenario:'healthy',ttftMs:0,count:2,successCount:1,coverage:{ttftMs:1}},
      {method:'parallel',scenario:'healthy',ttftMs:null,count:2,successCount:0,coverage:{ttftMs:0}},
    ]} });
  const html = context.campaignComparisonView();
  assert.match(html,/0\.00 ms/); assert.match(html,/1\/2/); assert.match(html,/0\/2/);
  assert.doesNotMatch(html,/NaN|Infinity|undefined/);
});

test('provider and payload series retain unknowns and zeros without inventing network rates', () => {
  const samples = distributedPerformance([{ ...run, distributed: null }, run]);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].ttftMs, null);
  assert.equal(samples[0].tokensPerSecond, null);
  assert.equal(samples[0].responseBytesReceived, 0);
  assert.equal(samples[1].ttftMs, 0);
  assert.equal(samples[2].elapsedMs, 200);
  assert.equal(samples[2].kind, 'core');
  assert.ok(!Object.hasOwn(samples[0], 'bandwidth'));
  assert.ok(!Object.hasOwn(samples[0], 'rttMs'));
  const invalid = structuredClone(run);
  invalid.distributed.calls[0].endedAt = 1700;
  invalid.distributed.attempts[0].ttftMs = -1;
  invalid.distributed.attempts[0].tpotMs = Infinity;
  assert.equal(distributedPerformance([invalid])[0].ttftMs, null);
  assert.equal(distributedPerformance([invalid])[0].tpotMs, null);
  assert.equal(distributedPerformance([invalid])[2].elapsedMs, null);
});

test('same-run central-observed event lanes include failed primary, adopted backup, and core calls chronologically', () => {
  const events = distributedRunEvents(run);
  assert.deepEqual(events.map(event => event.at), [1000,1100,1400,1400,1700,1750,1950,2000]);
  assert.ok(events.every(event => event.source === 'central-observed'));
  assert.equal(events.filter(event => event.lane === 'node' && event.nodeId === 'node-a').length, 2);
  assert.match(events[2].message, /failed \(attempt-timeout\).*not adopted/);
  assert.match(events[4].message, /succeeded.*adopted/);
  assert.equal(events[5].lane, 'central');
  const active = { ...run, status: 'running', completedAt: null };
  assert.ok(!distributedRunEvents(active).some(event => event.message === 'run running'));
});

test('CSV exports provider timing columns and retain missing values as empty cells', () => {
  for (const csv of [distributedAttemptsCsv([run]), distributedCallsCsv([run])]) {
    assert.match(csv, /"ttftMs","tpotMs","tokensPerSecond"/);
    assert.doesNotMatch(csv, /undefined|NaN|Infinity/);
  }
  assert.match(distributedAttemptsCsv([run]), /"0","10","100"/);
  assert.match(distributedCallsCsv([run]), /"25","5","200"/);
});

test('charts break paths at nulls, preserve zero values, escape labels, and label provider rate inference', () => {
  const ui = browser();
  const samples = [1, null, 0].map((value,index) => ({ at: 1100+index*100, ttftMs: value,
    nodeId: '<script>node</script>', agentId: 'tech', kind: 'agent', id: 'a', runId: 'RUN-demo' }));
  const chart = ui.performanceChart(samples, 'ttftMs', 'TTFT', 'ms');
  assert.equal((chart.match(/<circle /g) ?? []).length, 2);
  assert.match(chart, /d="M[^"L]* M/);
  assert.doesNotMatch(chart, /<script>/);
  assert.match(chart, /&lt;script&gt;/);
  assert.match(ui.distributedPerformanceView({ performance: [] }), /미측정/);
  assert.match(ui.distributedPerformanceView({ performance: samples }), /측정 TPOT의 역수/);
});

test('log selection isolates run and instance and keeps native stdout and KOREN provenance explicit', () => {
  const other = { ...run, instanceId: 'instance-b' };
  const ui = browser({ selectedExecution: 'instance-b/RUN-demo' });
  const html = ui.executionLogsView([run, other], { executionLogs: [
    { runId: run.runId, instanceId: 'instance-a', events: [{ at: 1200, lane: 'central', id: 'DO-NOT-SHOW', message: 'wrong instance' }] },
    { runId: run.runId, instanceId: 'instance-b', events: distributedRunEvents(run) },
  ] });
  assert.doesNotMatch(html, /DO-NOT-SHOW|wrong instance/);
  assert.match(html, /중앙 오케스트레이터/);
  assert.match(html, /노드 node-a/);
  assert.match(html, /노드 node-b/);
  assert.match(html, /central-observed/);
  assert.match(html, /native stdout/);
  assert.match(html, /KOREN 경로 통과/);
});

test('TCP probes show failures separately and exclude samples outside selected range', () => {
  const ui = browser({ networkData: { semantics: 'tcp-connect', targets: [{ nodeId: 'edge-1', samples: [
    { timestamp: 500, success: true, connectMs: 1 },
    { timestamp: 1100, success: true, connectMs: 12 },
    { timestamp: 1200, success: false, connectMs: null },
  ] }] } });
  const html = ui.networkPerformanceView();
  assert.equal((html.match(/<circle /g) ?? []).length, 1);
  assert.match(html, /성공 1\/2 \(50.0%\) · 실패 1/);
  assert.match(html, /ICMP RTT/);
  assert.match(html, /독립 탐침/);
  ui.networkData = { targets: [] };
  assert.match(ui.networkPerformanceView(), /미설정/);
  ui.networkData = { error: 'unavailable' };
  assert.match(ui.networkPerformanceView(), /조회 실패/);
});
