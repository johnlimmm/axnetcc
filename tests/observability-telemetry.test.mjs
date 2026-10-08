import assert from 'node:assert/strict';
import test from 'node:test';
import { executionLog } from '../lib/execution-log.ts';
import { recordEdgeAttempt, recordInferenceStage, getDistributedRun } from '../lib/distributed-metrics.ts';
import { projectDistributedTelemetry } from '../lib/distributed-telemetry.ts';
import { createNetworkSampler, parseNetworkTargets, probeTcp } from '../monitor/network.mjs';
import { createServer } from 'node:net';

test('provider timings survive ledger and wire projection; invalid and historical timing stays null', () => {
  const id = 'observe-test';
  recordEdgeAttempt(id, { attemptId: 'attempt-1', requestId: id, agentId: 'tech', nodeId: 'primary', replicaId: 'tech-primary', role: 'primary',
    startedAt: 100, completedAt: 200, elapsedMs: 100, queueWaitMs: 0, requestBytesPrepared: 10, responseBytesReceived: 20,
    status: 'succeeded', reasonCode: null, backend: 'ollama', model: 'model', promptTokens: 3, completionTokens: 2, usageStatus: 'measured', adopted: true,
    ttftMs: 20.5, tpotMs: 4, tokensPerSecond: 250 });
  recordInferenceStage(id, 'synthesis', { backend: 'ollama', model: 'model', promptTokens: 2, completionTokens: 1,
    ttftMs: NaN, tpotMs: -1, tokensPerSecond: Infinity }, 'call-1');
  const safe = projectDistributedTelemetry(getDistributedRun(id), id);
  assert.equal(safe.attempts[0].ttftMs, 20.5);
  assert.equal(safe.attempts[0].tokensPerSecond, 250);
  assert.equal(safe.calls[0].ttftMs, null);
  assert.equal(safe.calls[0].tpotMs, null);
  assert.equal(safe.calls[0].tokensPerSecond, null);
  delete safe.attempts[0].ttftMs;
  assert.equal(projectDistributedTelemetry(safe, id).attempts[0].ttftMs, null);
});

test('execution logs are opt-in and allowlist metadata without payload secrets', () => {
  const enabled = process.env.EXECUTION_LOG_ENABLED, original = console.log, lines = [];
  console.log = line => lines.push(line);
  try {
    delete process.env.EXECUTION_LOG_ENABLED;
    executionLog('edge-received', { requestId: 'run' });
    assert.equal(lines.length, 0);
    process.env.EXECUTION_LOG_ENABLED = 'true';
    executionLog('edge-completed', { requestId: 'run', nodeId: 'secret://url', query: 'SECRET', elapsedMs: NaN });
    const row = JSON.parse(lines[0]);
    assert.equal(row.requestId, 'run'); assert.equal(row.nodeId, null); assert.equal(row.elapsedMs, null);
    assert.ok(!lines[0].includes('SECRET')); assert.ok(!lines[0].includes('secret://'));
  } finally { console.log = original; if (enabled === undefined) delete process.env.EXECUTION_LOG_ENABLED; else process.env.EXECUTION_LOG_ENABLED = enabled; }
});

test('network target validation and sampler never disclose addresses', async () => {
  assert.throws(() => parseNetworkTargets('[{"nodeId":"a","host":"bad/path","port":22}]'));
  assert.throws(() => parseNetworkTargets('[{"nodeId":"a","host":"localhost","port":22},{"nodeId":"a","host":"localhost","port":23}]'));
  const sampler = createNetworkSampler(parseNetworkTargets('[{"nodeId":"a","host":"private.example","port":22}]'), {
    probe: async () => ({ timestamp: 1, success: false, connectMs: null }) });
  sampler.start(); await sampler.stop();
  const value = sampler.snapshot(); assert.equal(value.targets[0].samples[0].connectMs, null);
  assert.ok(!JSON.stringify(value).includes('private.example'));
});

test('TCP probe records real connect observations and failures as missing latency', async () => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const good = await probeTcp({ host: '127.0.0.1', port });
  assert.equal(good.success, true); assert.ok(good.connectMs >= 0);
  await new Promise(resolve => server.close(resolve));
  const failed = await probeTcp({ host: '127.0.0.1', port });
  assert.equal(failed.success, false); assert.equal(failed.connectMs, null);
});
