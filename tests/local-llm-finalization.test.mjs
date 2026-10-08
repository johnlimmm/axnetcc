import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLocalAnswer } from '../lib/local-llm.ts';
import { markInferenceAccountingIncomplete, getDistributedRun } from '../lib/distributed-metrics.ts';
import { projectDistributedTelemetry } from '../lib/distributed-telemetry.ts';

const input = { agent: 'tech', agentName: 'Tech', responsibility: 'test', query: 'public test', evidence: [], fallback: 'fallback' };
async function withStream(parts, run) {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.LOCAL_LLM_BASE_URL;
  process.env.LOCAL_LLM_BASE_URL = 'http://localhost:11434';
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(typeof part === 'string' ? new TextEncoder().encode(part) : part);
    controller.close();
  }}));
  try { return await run(); } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.LOCAL_LLM_BASE_URL; else process.env.LOCAL_LLM_BASE_URL = oldUrl;
  }
}
const chunk = (content, done = false, counters = {}) => JSON.stringify({ message: { content }, done, ...counters });

test('throwing metrics callback preserves success while accounting fails closed without leaking its error',async()=>{
  const requestId='RUN-callback-failure';
  await withStream([chunk('answer',true,{prompt_eval_count:7,eval_count:3})],async()=>{
    const result=await generateLocalAnswer({...input,onMetrics:()=>{throw new Error('SECRET callback detail');},onAccountingFailure:m=>markInferenceAccountingIncomplete(requestId,'synthesis',m,'failed-observer')});
    assert.equal(result.metrics.backend,'ollama');assert.equal(result.metrics.status,'succeeded');
    assert.equal(result.metrics.accountingFailure,'metrics-callback-failed');
    const projected=projectDistributedTelemetry(getDistributedRun(requestId),requestId);
    assert.equal(projected.accountingIncomplete,true);assert.equal(projected.totals.promptTokens,null);assert.equal(projected.totals.completionTokens,null);
    assert.equal(projected.totals.knownPromptTokens,7);assert.equal(projected.totals.knownCompletionTokens,3);
    assert.doesNotMatch(JSON.stringify({result,projected}),/SECRET/);
  });
});

test('throwing callback on cancellation preserves the same abort and marks Core accounting incomplete',async()=>{
  const controller=new AbortController(),reason=new Error('caller abort'),requestId='RUN-cancel-observer';controller.abort(reason);
  await assert.rejects(generateLocalAnswer({...input,signal:controller.signal,onMetrics:()=>{throw new Error('SECRET');},onAccountingFailure:m=>markInferenceAccountingIncomplete(requestId,'synthesis',m,'cancel-observer')}),error=>error===reason);
  const projected=projectDistributedTelemetry(getDistributedRun(requestId),requestId);
  assert.equal(projected.accountingIncomplete,true);assert.equal(projected.calls[0].status,'cancelled');assert.equal(projected.totals.promptTokens,null);
  assert.doesNotMatch(JSON.stringify(projected),/SECRET|caller abort/);
});

test('physical observation emits exactly once with application body bytes and no invented counters', async () => {
  const body=chunk('answer',true);const observations=[];
  await withStream([body],async()=>{
    const result=await generateLocalAnswer({...input,onMetrics:metrics=>observations.push(structuredClone(metrics))});
    assert.equal(observations.length,1);const observed=observations[0];
    assert.equal(observed.status,'succeeded');assert.equal(observed.requestSubmitted,true);
    assert.ok(observed.requestBytesPrepared>0);assert.equal(observed.responseBytesReceived,new TextEncoder().encode(body).length);
    assert.equal(observed.promptTokens,null);assert.equal(observed.completionTokens,null);
    assert.ok(observed.endedAt>=observed.startedAt);assert.equal(result.metrics.startedAt,observed.startedAt);
  });
});

test('prefetch abort emits once with no submission; partial stream abort retains received bytes',async()=>{
  const early=new AbortController();early.abort();const first=[];
  await assert.rejects(generateLocalAnswer({...input,signal:early.signal,onMetrics:m=>first.push(m)}));
  assert.equal(first.length,1);assert.equal(first[0].status,'cancelled');assert.equal(first[0].requestSubmitted,false);assert.equal(first[0].requestBytesPrepared,0);
  const oldFetch=globalThis.fetch,oldUrl=process.env.LOCAL_LLM_BASE_URL;process.env.LOCAL_LLM_BASE_URL='http://localhost:11434';
  const controller=new AbortController(),observations=[];const partial=chunk('partial')+'\n';
  globalThis.fetch=async()=>new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(partial));setTimeout(()=>{controller.abort();stream.error(new Error('cancelled'));},5);}}));
  try {
    await assert.rejects(generateLocalAnswer({...input,signal:controller.signal,onMetrics:m=>observations.push(m)}));
    assert.equal(observations.length,1);assert.equal(observations[0].status,'cancelled');assert.equal(observations[0].requestSubmitted,true);
    assert.equal(observations[0].responseBytesReceived,new TextEncoder().encode(partial).length);assert.equal(observations[0].completionTokens,null);
  } finally {globalThis.fetch=oldFetch;if(oldUrl===undefined)delete process.env.LOCAL_LLM_BASE_URL;else process.env.LOCAL_LLM_BASE_URL=oldUrl;}
});
test('final EOF JSON without newline and fragmented UTF8 are finalized correctly', async () => {
  const bytes = new TextEncoder().encode(chunk('한국어') + '\n' + chunk('', true, { prompt_eval_count: 4, eval_count: 2, eval_duration: 2000000 }));
  await withStream([...bytes].map(byte => new Uint8Array([byte])), async () => {
    const result = await generateLocalAnswer(input);
    assert.equal(result.text, '한국어');
    assert.equal(result.metrics.backend, 'ollama');
    assert.equal(result.metrics.promptTokens, 4);
    assert.equal(result.metrics.tpotMs, 1);
  });
});
test('missing counters stay null; chunk arrival gaps are not token timing', async () => {
  await withStream([chunk('a') + '\n', chunk('b', true)], async () => {
    const { metrics } = await generateLocalAnswer(input);
    assert.equal(metrics.backend, 'ollama');
    for (const key of ['promptTokens', 'completionTokens', 'tpotMs', 'tokensPerSecond']) assert.equal(metrics[key], null);
    assert.equal(metrics.providerFinalObserved,true);
  });
});

test('clean provider EOF proves completion even when empty output is rejected, but done alone does not',async()=>{
  await withStream([chunk('',true,{prompt_eval_count:7,eval_count:3})],async()=>{
    const result=await generateLocalAnswer(input);
    assert.equal(result.metrics.backend,'deterministic');assert.equal(result.metrics.failureCode,'invalid-response');assert.equal(result.metrics.providerFinalObserved,true);
  });
  for(const suffix of ['\n{"error":"provider failed"}','\n{corrupt',new Uint8Array([255])]){
    await withStream([chunk('answer',true,{prompt_eval_count:7,eval_count:3}),suffix],async()=>{
      const result=await generateLocalAnswer(input);assert.equal(result.metrics.providerFinalObserved,false);
    });
  }
});
for (const [name, body, code] of [
  ['missing done', chunk('partial'), 'invalid-response'],
  ['truncated JSON', chunk('partial') + '\n{"done":', 'invalid-response'],
  ['provider error after text', chunk('partial') + '\n{"error":"secret provider detail"}', 'provider-error'],
  ['error after done', chunk('final', true) + '\n{"error":"bad"}', 'invalid-response'],
  ['empty output', chunk('', true), 'invalid-response'],
  ['invalid counters', chunk('text', true, { eval_count: -1 }), 'invalid-response'],
  ['oversized response', 'x'.repeat(2 * 1024 * 1024 + 1), 'invalid-response'],
]) test(name + ' cannot be real success', async () => {
  await withStream([body], async () => {
    const result = await generateLocalAnswer(input);
    assert.equal(result.text, 'fallback');
    assert.equal(result.metrics.backend, 'deterministic');
    assert.equal(result.metrics.failureCode, code);
    assert.equal(result.metrics.providerFinalObserved,name==='empty output');
    assert.equal(result.metrics.completionTokens, null);
    assert.ok(!result.metrics.fallbackReason.includes('secret'));
  });
});
test('caller abort is thrown rather than converted to fallback', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancel', 'AbortError'));
  await assert.rejects(generateLocalAnswer({ ...input, signal: controller.signal }), { name: 'AbortError' });
});
test('typed refused connection is transient, unknown provider errors are not', async () => {
  await withStream([], async () => {
    globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
    assert.equal((await generateLocalAnswer(input)).metrics.failureCode, 'connection');
    globalThis.fetch = async () => new Response('provider bad configuration', { status: 503 });
    assert.equal((await generateLocalAnswer(input)).metrics.failureCode, 'provider-error');
  });
});
test('caller abort during inference remains cancellation; local timeout is transient', async () => {
  await withStream([], async () => {
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const controller = new AbortController();
    const pending = generateLocalAnswer({ ...input, signal: controller.signal });
    controller.abort(new DOMException('stop', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
    const previous = process.env.LOCAL_LLM_TIMEOUT_MS;
    process.env.LOCAL_LLM_TIMEOUT_MS = '5';
    try { assert.equal((await generateLocalAnswer(input)).metrics.failureCode, 'timeout'); }
    finally { if (previous === undefined) delete process.env.LOCAL_LLM_TIMEOUT_MS; else process.env.LOCAL_LLM_TIMEOUT_MS = previous; }
  });
});

test('validated finalized counters survive empty output and an error after finalization', async () => {
  for (const body of [chunk('', true, { prompt_eval_count: 17, eval_count: 0 }), chunk('answer', true, { prompt_eval_count: 17, eval_count: 3 }) + '\n{"error":"provider failure"}']) {
    await withStream([body], async () => {
      const result = await generateLocalAnswer(input);
      assert.equal(result.metrics.backend, 'deterministic');
      assert.equal(result.metrics.promptTokens, 17);
      assert.ok([0, 3].includes(result.metrics.completionTokens));
      assert.equal(result.metrics.failureCode, 'invalid-response');
    });
  }
});
test('only allowlisted HTTP status and exact provider code are transient', async () => {
  await withStream([], async () => {
    for (const [status, code, expected] of [[503, 'inference-unavailable', 'connection'], [502, 'inference-unavailable', 'connection'], [504, 'inference-unavailable', 'connection'], [401, 'inference-unavailable', 'provider-error'], [503, 'configuration', 'provider-error']]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code }), { status });
      assert.equal((await generateLocalAnswer(input)).metrics.failureCode, expected);
    }
  });
});
