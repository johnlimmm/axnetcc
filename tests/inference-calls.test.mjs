import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInferenceStage, getDistributedRun } from '../lib/distributed-metrics.ts';
import { projectDistributedTelemetry } from '../lib/distributed-telemetry.ts';
import { TelemetryRegistry } from '../lib/telemetry.ts';
import { openMonitorStore } from '../monitor/store.mjs';
import { distributedCallsCsv } from '../monitor/distributed.mjs';
import { residualComputeRisk } from '../scripts/benchmark-distributed-demo.mjs';

test('Core failed rendering proof survives ledger and telemetry without changing rejected answer status',()=>{
  const id='RUN-Core-render-rejected';
  recordInferenceStage(id,'synthesis',{backend:'deterministic',model:'test',promptTokens:null,completionTokens:null,status:'failed',failureCode:'invalid-response',providerFinalObserved:true},'core-final-rejected');
  const projected=projectDistributedTelemetry(getDistributedRun(id),id);
  assert.equal(projected.calls[0].providerFinalObserved,true);assert.equal(projected.calls[0].failureCode,'invalid-response');assert.equal(projected.calls[0].backend,'deterministic');
  assert.equal(projected.totals.promptTokens,null);assert.equal(residualComputeRisk({distributed:projected}),false);
});

test('same-stage calls survive projection/store/export, replay once and unknown retains subtotal', () => {
  const requestId = 'RUN-calls-regression';
  const metrics = (promptTokens,completionTokens) => ({ backend:'ollama',model:'test-model',promptTokens,completionTokens });
  recordInferenceStage(requestId,'synthesis',metrics(7,3),'call-1');
  recordInferenceStage(requestId,'synthesis',metrics(11,5),'call-2');
  recordInferenceStage(requestId,'synthesis',metrics(11,5),'call-2');
  let raw = getDistributedRun(requestId), projected = projectDistributedTelemetry(raw,requestId);
  assert.equal(raw.calls.length,2); assert.equal(projected.calls.length,2);
  assert.equal(projected.totals.promptTokens,18); assert.equal(projected.totals.completionTokens,8);
  assert.equal(projected.stages[0].promptTokens,18);
  recordInferenceStage(requestId,'repair',metrics(null,null),'failed-call');
  raw = getDistributedRun(requestId); projected = projectDistributedTelemetry(raw,requestId);
  assert.equal(projected.totals.promptTokens,null); assert.equal(projected.totals.knownPromptTokens,18);
  assert.equal(projected.totals.knownCompletionTokens,8); assert.equal(projected.totals.inferenceCount,3);
  assert.deepEqual(projectDistributedTelemetry(projected,requestId).calls,projected.calls);
  const csv = distributedCallsCsv([{ instanceId:'instance',runId:requestId,status:'completed',distributed:projected }]);
  assert.match(csv,/call-1/); assert.match(csv,/call-2/); assert.match(csv,/failed-call/);
  const store = openMonitorStore(':memory:');
  try {
    const registry = new TelemetryRegistry(() => 2000);
    registry.begin(requestId,'proposed'); registry.finish(requestId,'completed');
    const packet = registry.snapshot(); store.ingest(packet);
    const found = store.findRun(packet.instanceId,requestId);
    assert.deepEqual(found.distributed.calls,projected.calls);
  } finally { store.close(); }
});
test('historical stage-only snapshots do not fabricate a per-call history', () => {
  const old = projectDistributedTelemetry({ version:'1',requestId:'RUN-old',attempts:[],stages:[{ stage:'synthesis',backend:'ollama',model:'old',promptTokens:7,completionTokens:3 }] },'RUN-old');
  assert.equal(old.callDetail,'legacy-stage-only'); assert.deepEqual(old.calls,[]);
  assert.equal(old.totals.knownPromptTokens,7);
  assert.equal(projectDistributedTelemetry(old,'RUN-old').totals.knownPromptTokens,7);
});

test('Core physical-call metadata is sanitized, idempotent and separate from Agent body totals', () => {
  const requestId='RUN-core-body-metrics';
  const metrics={backend:'deterministic',model:'test-model',nodeId:'HPC-VM',startedAt:1000,endedAt:1250,status:'cancelled',requestBytesPrepared:123,requestSubmitted:true,responseBytesReceived:47,promptTokens:null,completionTokens:null};
  recordInferenceStage(requestId,'synthesis',metrics,'core-aborted');
  recordInferenceStage(requestId,'synthesis',metrics,'core-aborted');
  const raw=getDistributedRun(requestId),safe=projectDistributedTelemetry(raw,requestId);
  assert.equal(safe.calls.length,1);assert.equal(safe.calls[0].nodeId,'HPC-VM');assert.equal(safe.calls[0].status,'cancelled');
  assert.equal(safe.calls[0].startedAt,1000);assert.equal(safe.calls[0].endedAt,1250);
  assert.equal(safe.calls[0].requestSubmitted,true);assert.equal(safe.calls[0].responseBytesReceived,47);
  assert.equal(safe.totals.promptTokens,null);assert.equal(safe.totals.requestBytesPrepared,0);
  assert.equal(safe.coreBodyBytes.requestBytesPrepared.value,123);assert.equal(safe.coreBodyBytes.responseBytesReceived.value,47);
  assert.equal(safe.coreBodyBytes.submittedCallCount,1);
  assert.match(safe.coreBodyBytes.semantics,/not delivery or NIC traffic/);
  assert.deepEqual(projectDistributedTelemetry(safe,requestId).coreBodyBytes,safe.coreBodyBytes);
  const csv=distributedCallsCsv([{instanceId:'instance',runId:requestId,status:'cancelled',distributed:safe}]);
  assert.match(csv,/"HPC-VM","1000","1250","cancelled","123","true","47"/);
});
test('historical and invalid Core fields stay unknown rather than inventing timing or bytes',()=>{
  const requestId='RUN-core-historical';
  recordInferenceStage(requestId,'synthesis',{backend:'ollama',model:'test',promptTokens:7,completionTokens:3},'old-call');
  let safe=projectDistributedTelemetry(getDistributedRun(requestId),requestId);
  for(const field of ['nodeId','startedAt','endedAt','status','requestBytesPrepared','requestSubmitted','responseBytesReceived'])assert.equal(safe.calls[0][field],null);
  assert.equal(safe.coreBodyBytes.requestBytesPrepared.value,null);assert.equal(safe.coreBodyBytes.requestBytesPrepared.known,0);
  const tainted={...safe,calls:[{...safe.calls[0],nodeId:'http://secret',startedAt:100,endedAt:99,requestBytesPrepared:-1,responseBytesReceived:'secret',status:'SECRET',requestSubmitted:'true',prompt:'SECRET'}]};
  safe=projectDistributedTelemetry(tainted,requestId);
  assert.equal(safe.calls[0].endedAt,null);assert.equal(safe.calls[0].nodeId,null);assert.equal(safe.calls[0].requestSubmitted,null);
  assert.ok(!JSON.stringify(safe).includes('SECRET'));
});

test('cancelled provider stream reaches one final Core ledger record with received partial bytes',async t=>{
  const {generateLocalAnswer}=await import('../lib/local-llm.ts');
  const controller=new AbortController(),requestId='RUN-provider-cancel-ledger';
  const previous=process.env.LOCAL_LLM_BASE_URL;process.env.LOCAL_LLM_BASE_URL='http://localhost:13434';
  const partial=JSON.stringify({message:{content:'partial'},done:false})+'\n';let observed=0;
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(stream){
    stream.enqueue(new TextEncoder().encode(partial));setTimeout(()=>{controller.abort();stream.error(new Error('test cancellation'));},5);
  }})));
  try{
    await assert.rejects(generateLocalAnswer({agent:'tech',agentName:'Tech',responsibility:'test',query:'test',evidence:[],fallback:'fallback',signal:controller.signal,
      onMetrics:metrics=>{observed++;recordInferenceStage(requestId,'synthesis',{...metrics,nodeId:'HPC-VM'},'physical-core-cancel');}}));
    const safe=projectDistributedTelemetry(getDistributedRun(requestId),requestId);
    assert.equal(observed,1);assert.equal(safe.calls.length,1);assert.equal(safe.calls[0].status,'cancelled');
    assert.equal(safe.calls[0].responseBytesReceived,new TextEncoder().encode(partial).length);
    assert.equal(safe.calls[0].requestSubmitted,true);assert.ok(safe.calls[0].requestBytesPrepared>0);
    assert.equal(safe.calls[0].promptTokens,null);assert.equal(safe.calls[0].completionTokens,null);
    assert.equal(safe.coreBodyBytes.responseBytesReceived.value,new TextEncoder().encode(partial).length);
  }finally{if(previous===undefined)delete process.env.LOCAL_LLM_BASE_URL;else process.env.LOCAL_LLM_BASE_URL=previous;}
});
