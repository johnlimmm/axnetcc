import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDemoRequest, validateDemoOptions, createDemoDeadline, demoRunTimeoutMs } from '../lib/demo-profile.ts';
import { RunRegistry } from '../lib/run-registry.ts';

async function env(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('service rejects bypass mode and all paid judge values; ordinary profile compatible', async () => {
  await env({ DEMO_PROFILE: 'service' }, async () => {
    assert.equal(validateDemoOptions({ mode: 'parallel' }).status, 403);
    for (const value of [true, 'true', 1]) assert.equal(validateDemoOptions({ commercialJudge: value }).status, 403);
    assert.equal(validateDemoOptions({ mode: 'proposed', commercialJudge: false }), null);
    assert.equal(validateDemoOptions({}), null);
    assert.equal(demoRunTimeoutMs(), 120000);
  });
  await env({ DEMO_PROFILE: '' }, async () => {
    assert.equal(validateDemoOptions({ mode: 'parallel', commercialJudge: true }), null);
    assert.equal(demoRunTimeoutMs(), null);
  });
});
test('operator auth fails closed and never authorizes paid judge', async () => {
  await env({ DEMO_PROFILE: 'operator', DEMO_OPERATOR_TOKEN: 'test-only-secret' }, async () => {
    assert.equal(authorizeDemoRequest(new Request('http://localhost')).status, 401);
    assert.equal(authorizeDemoRequest(new Request('http://localhost', { headers: { authorization: 'Bearer test-only-secret' } })), null);
    assert.equal(validateDemoOptions({ mode: 'parallel', commercialJudge: false }), null);
    assert.equal(validateDemoOptions({ commercialJudge: true }).status, 403);
  });
});
test('absolute deadline includes elapsed acceptance time and parent abort', async () => {
  await env({ DEMO_PROFILE: 'service', DEMO_RUN_TIMEOUT_MS: '30' }, async () => {
    const deadline = createDemoDeadline(undefined, Date.now() - 40);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(deadline.expired, true);
    assert.equal(deadline.signal.aborted, true);
    deadline.dispose();
    const controller = new AbortController();
    const parent = createDemoDeadline(controller.signal);
    controller.abort();
    assert.equal(parent.signal.aborted, true);
    assert.equal(parent.expired, false);
    parent.dispose();
  });
});
test('registry deadline terminal is distinct from executor drain; late completion is rejected', async () => {
  await env({ DEMO_PROFILE: 'service', DEMO_RUN_TIMEOUT_MS: '15' }, async () => {
    let release;
    let signal;
    const gate = new Promise(resolve => { release = resolve; });
    const registry = new RunRegistry({ idFactory: () => 'RUN-DEADLINE-TEST', executor: async (_input, _report, receivedSignal) => { signal = receivedSignal; await gate; return { conclusion: 'late result' }; } });
    let execution;
    await registry.start({ query: 'public query', mode: 'proposed', commercialJudge: false }, promise => { execution = promise; });
    await new Promise(resolve => setTimeout(resolve, 35));
    const snapshot = registry.get('RUN-DEADLINE-TEST');
    assert.equal(snapshot.status, 'cancelled');
    assert.equal(snapshot.errorCode, 'DEADLINE_EXCEEDED');
    assert.equal(snapshot.executionSettled, false);
    assert.equal(signal.aborted, true);
    release();
    await execution;
    assert.equal(registry.get('RUN-DEADLINE-TEST').executionSettled, true);
    assert.equal(registry.get('RUN-DEADLINE-TEST').result, undefined);
    assert.equal(registry.get('RUN-DEADLINE-TEST').errorCode, 'DEADLINE_EXCEEDED');
  });
});
