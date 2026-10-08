import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { TelemetryRegistry } from '../lib/telemetry.ts';
import { recordEdgeAttempt, recordInferenceStage } from '../lib/distributed-metrics.ts';
import { projectDistributedTelemetry } from '../lib/distributed-telemetry.ts';
import { openMonitorStore } from '../monitor/store.mjs';
import { distributedAttemptsCsv, distributedSummary } from '../monitor/distributed.mjs';
import { startMonitor } from '../monitor/server.mjs';

const attempt = (run, override = {}) => ({ attemptId: `${run}-primary`, requestId: run, agentId: 'tech', nodeId: 'ai-cloud', replicaId: 'primary-tech', role: 'primary', startedAt: 1000, completedAt: 1200, elapsedMs: 200, queueWaitMs: 0, requestBytesPrepared: 80, responseBytesReceived: 10, status: 'failed', reasonCode: 'inference-unavailable', backend: null, model: null, promptTokens: null, completionTokens: null, usageStatus: 'unknown', adopted: false, ...override });
test('late cancelled attempt costs revise telemetry and deduplicate stored/exported totals', () => {
  const id = 'RUN-distributed-late';
  const source = new TelemetryRegistry(() => 1400);
  source.begin(id, 'proposed'); source.finish(id, 'cancelled');
  const first = source.snapshot();
  assert.equal(first.runs[0].distributed, null);
  recordEdgeAttempt(id, attempt(id));
  const late = source.snapshot(first.nextCursor, first.instanceId);
  assert.equal(late.runs.length, 1);
  assert.ok(late.nextCursor > first.nextCursor);
  assert.equal(source.snapshot(late.nextCursor, first.instanceId).runs.length, 0);
  recordEdgeAttempt(id, attempt(id, { attemptId: `${id}-backup`, role: 'backup', nodeId: 'mnckoren', replicaId: 'backup-tech', backend: 'ollama', model: 'qwen3:4b', status: 'succeeded', reasonCode: null, promptTokens: 7, completionTokens: 0, usageStatus: 'measured', adopted: false, responseBytesReceived: 50 }));
  recordInferenceStage(id, 'synthesis', { backend: 'ollama', model: 'qwen3:4b', promptTokens: 3, completionTokens: 2 });
  const final = source.snapshot(late.nextCursor, first.instanceId);
  const store = openMonitorStore(':memory:');
  try {
    store.ingest(first); store.ingest(late); store.ingest(final); store.ingest(final); store.ingest(late);
    const summary = store.summary({ from: 0, to: 10000 });
    const totals = summary.distributed.totals;
    assert.equal(summary.runs.length, 1);
    assert.equal(summary.distributed.allTerminal.count, 1);
    assert.equal(summary.distributed.finalizedRealSuccess.count, 0);
    assert.equal(totals.promptTokens, null);
    assert.equal(totals.knownPromptTokens, 10);
    assert.equal(totals.knownCompletionTokens, 2);
    assert.equal(totals.unknownCount, 1);
    assert.equal(totals.requestBytesPrepared, 160);
    assert.equal(totals.responseBytesReceived, 60);
    assert.equal(totals.retryKnownPromptTokens, 7);
    const stored = store.findRun(first.instanceId, id);
    assert.equal(stored.distributed.attempts.length, 2);
    assert.equal(stored.distributed.attempts[1].completionTokens, 0);
    const csv = distributedAttemptsCsv(summary.runs);
    assert.equal(csv.split('\r\n').length, 3);
    assert.ok(csv.includes('"7","0","measured","false"'));
    assert.ok(csv.includes('"inference-unavailable"'));
  } finally { store.close(); }
});
test('wire projection rejects unbounded packets and strips unknown secrets; totals never trust sender', () => {
  const id = 'RUN-projection-test';
  const raw = { version: '1', requestId: id, attempts: [attempt(id, { prompt: 'SECRET', endpoint: 'http://secret', reasonCode: 'secret error text' })], stages: [], totals: { promptTokens: 999 } };
  const safe = projectDistributedTelemetry(raw, id);
  assert.equal(safe.totals.promptTokens, null);
  assert.equal(safe.attempts[0].reasonCode, 'unknown-failure');
  assert.ok(!JSON.stringify(safe).includes('SECRET'));
  assert.ok(!JSON.stringify(safe).includes('http://secret'));
  assert.equal(projectDistributedTelemetry({ ...raw, attempts: Array(65).fill(attempt(id)) }, id), null);
  assert.equal(projectDistributedTelemetry(undefined, id), null);
});
test('service hides evaluation controls and fixes request mode/judge without removing response journey', async () => {
  const service = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(service, /requestModeGrid|judgeToggle|setCommercialJudgeEnabled/);
  assert.match(service, /query, mode: "proposed", commercialJudge: false/);
  assert.match(service, /id="request-title">MNC FLOW/);
  for (const hook of ['service-resilience-status','integrated-report','result-agent-evidence']) assert.ok(service.includes(hook));
  assert.ok(service.includes('FeedbackForm'));
});
test('distributed console serves GET-only page and matching attempt CSV without legacy mixing', async () => {
  const id = 'RUN-distributed-http';
  const source = new TelemetryRegistry();
  source.begin(id, 'proposed');
  recordEdgeAttempt(id, attempt(id, { backend: 'ollama', model: 'qwen3:4b', adopted: true, status: 'succeeded', reasonCode: null, promptTokens: 4, completionTokens: 2, usageStatus: 'measured' }));
  source.finish(id, 'completed');
  const monitor = await startMonitor({ port: 0, database: ':memory:', serviceUrl: 'http://fixture.test', fetchImpl: async url => {
    const parsed = new URL(url);
    return Response.json(parsed.pathname.endsWith('health') ? { agents: [] } : source.snapshot(Number(parsed.searchParams.get('after')), parsed.searchParams.get('instance')));
  } });
  try {
    await monitor.collector.collect();
    for (let i = 0; i < 30 && monitor.store.summary({ from: 0, to: Date.now()+1 }).runs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await fetch(monitor.url+'/distributed')).status, 200);
    assert.equal((await fetch(monitor.url+'/api/attempts.csv', { method: 'POST' })).status, 405);
    const csv = await (await fetch(monitor.url+'/api/attempts.csv')).text();
    assert.ok(csv.includes(id)); assert.ok(csv.includes('requestBytesPrepared')); assert.ok(!csv.includes('prompt,'));
    const summary = await (await fetch(monitor.url+'/api/summary')).json();
    assert.equal(summary.distributed.finalizedRealSuccess.count, 1);
    assert.equal(summary.distributed.totals.promptTokens, 4);
  } finally { await monitor.stop(); }
});

test('source kinds and deployment groups stay explicit; legacy counters do not enter distributed totals', () => {
  const base = { runId: 'RUN-groups', status: 'completed', startedAt: 100, completedAt: 200, metrics: {} };
  const raw = { version: '1', requestId: base.runId, source: 'configured-demo', deploymentId: 'demo-20260923', attempts: [attempt(base.runId, { status: 'succeeded', adopted: true, backend: 'ollama', promptTokens: 0, completionTokens: 0, usageStatus: 'measured' })], stages: [] };
  const demo = projectDistributedTelemetry(raw, base.runId);
  const unclassified = projectDistributedTelemetry({ ...raw, deploymentId: null, source: 'unclassified' }, base.runId);
  const summary = distributedSummary([{ ...base, distributed: demo }, { ...base, distributed: unclassified }, { ...base, distributed: null }]);
  assert.deepEqual(summary.sourceCounts, { 'configured-demo': 1, unclassified: 1 });
  assert.deepEqual(summary.deploymentCounts, { 'demo-20260923': 1, unclassified: 1 });
  assert.equal(summary.legacyRunsExcluded, 1);
  assert.equal(summary.totals.promptTokens, 0);
  assert.equal(summary.totals.completionTokens, 0);
});
