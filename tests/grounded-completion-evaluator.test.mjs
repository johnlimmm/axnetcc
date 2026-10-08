import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, nearestRank, validateManifest, validateGrades, validateConfig, summarizeCompletion, runConcurrent, verifyReport, finalizeAccounting } from '../scripts/evaluate-grounded-completion.mjs';
const roles = ['tech','data','security','legal','policy','finance','procurement','operations'];

test('post-cleanup accounting retains late cancelled Core cost without rewriting client observations', async () => {
  const initial = { attempts:[{attemptId:'a1',backend:'ollama',promptTokens:17,completionTokens:3}], calls:[], totals:{knownPromptTokens:17,knownCompletionTokens:3,promptTokens:17,completionTokens:3} };
  const sample = {caseId:'late',requestId:'RUN-late',status:'integrating',elapsedMs:60123,transcript:[{draft:'visible'}],transcriptComplete:false,computeCompletionProven:false,reason:'deadline',distributed:initial};
  const before = structuredClone(sample);
  const final = {...structuredClone(initial),calls:[{callId:'late-core',stage:'synthesis',backend:'deterministic',promptTokens:null,completionTokens:null}],totals:{knownPromptTokens:17,knownCompletionTokens:3,promptTokens:null,completionTokens:null}};
  const [result] = await finalizeAccounting({},[sample],{readSnapshot:async()=>({status:'cancelled',executionSettled:true}),readLedger:async()=>final});
  assert.deepEqual(sample,before); assert.equal(result.elapsedMs,60123); assert.deepEqual(result.transcript,sample.transcript);
  assert.equal(result.status,'integrating'); assert.equal(result.computeCompletionProven,false);
  assert.equal(result.distributed.calls[0].callId,'late-core'); assert.equal(result.distributed.totals.promptTokens,null);
  assert.equal(result.distributed.totals.knownPromptTokens,17); assert.equal(result.distributed.totals.knownCompletionTokens,3);
  assert.deepEqual(result.initialAccounting.distributed,initial); assert.equal(result.accountingFinalization.backendComputeCompletionUpgraded,false);
});

test('missing final ledger or unproved drain retains known subtotals but makes full totals unknown', async () => {
  const sample = {requestId:'RUN-missing',elapsedMs:42,computeCompletionProven:true,distributed:{attempts:[],calls:[],totals:{knownPromptTokens:9,knownCompletionTokens:2,promptTokens:9,completionTokens:2}}};
  for (const [ledger,snapshot] of [[null,{status:'completed',executionSettled:true}],[sample.distributed,{status:'integrating',executionSettled:false}]]) {
    const [result]=await finalizeAccounting({},[sample],{readLedger:async()=>ledger,readSnapshot:async()=>snapshot});
    assert.equal(result.computeCompletionProven,false);assert.equal(result.distributed.totals.promptTokens,null);
    assert.equal(result.distributed.totals.knownPromptTokens,9);assert.equal(result.accountingFinalization.status,'unproved');
  }
});

test('final accounting artifact binds initial immutable timing and transcript observations', async () => {
  const root=mkdtempSync(join(tmpdir(),'grounded-final-ledger-'));
  try {
    const {manifest,samples}=fixture();
    const initial=samples.map(sample=>JSON.stringify(sample)).join('\n');
    const finalized=await finalizeAccounting({},samples,{readLedger:async()=>null,readSnapshot:async()=>null});
    const finalBytes=finalized.map(sample=>JSON.stringify(sample)).join('\n'), mb=JSON.stringify(manifest);
    writeFileSync(join(root,'manifest.json'),mb);writeFileSync(join(root,'samples.jsonl'),initial);writeFileSync(join(root,'samples-final.jsonl'),finalBytes);
    const report={schemaVersion:'grounded-completion-report/v1',manifestFile:'manifest.json',manifestHash:digest(mb),samplesFile:'samples-final.jsonl',samplesHash:digest(finalBytes),initialSamplesFile:'samples.jsonl',initialSamplesHash:digest(initial),stopReason:'interrupted',cleanup:[]};
    writeFileSync(join(root,'report.json'),JSON.stringify(report));
    assert.equal(verifyReport(join(root,'report.json')).passed,false);
    finalized[0].elapsedMs=1;
    const changed=finalized.map(sample=>JSON.stringify(sample)).join('\n');
    writeFileSync(join(root,'samples-final.jsonl'),changed);report.samplesHash=digest(changed);writeFileSync(join(root,'report.json'),JSON.stringify(report));
    assert.throws(()=>verifyReport(join(root,'report.json')),/changed client observations/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
function fixture() {
  const hash = digest('test-only rubric'), cases = roles.flatMap(role => Array.from({length:5},(_,i) => ({ id:`${role}-${i}`,role,kind:'answerable',query:`test-only ${role} ${i}`,rubricHash:hash })));
  cases.push(...Array.from({length:10},(_,i) => ({ id:`safety-${i}`,role:roles[i%8],kind:i<6?'mixed':'unsupported',query:`test-only safety ${i}`,rubricHash:hash })));
  const manifest = { schemaVersion:'grounded-completion/v1',deploymentId:'test',authorId:'independent-author',runtimeAuthorId:'implementer',concurrency:3,deadlineMs:60000,watchdogMs:70000,maximumRequests:180,maximumWallMs:7200000,seed:17,frozenAt:'2026-01-01T00:00:00Z',configurationHash:hash,rubricHash:hash,workloadHash:digest(JSON.stringify(cases)),cases,readiness:{policy:'admit-cold',description:'test fixture'},artifacts:['build','corpus','prompts','models','configuration','rubrics'].map(kind => ({kind,path:`${kind}.json`,sha256:hash})) };
  const samples = cases.map(c => ({caseId:c.id,occurrence:1,status:'completed',hasFinal:true,elapsedMs:1000,transcriptComplete:true,computeCompletionProven:true}));
  const grades = {schemaVersion:'grounded-grades/v1',reviewType:'AI-assisted',graderId:'grader',adjudicatorId:'reviewer',workloadHash:manifest.workloadHash,rubricHash:hash,samplesHash:digest('samples'),auditMissedUnsupportedClaim:false,cases:cases.map(c => ({id:c.id,rubricHash:hash,F:true,C:true,U:true,safe:true,visibleClaimsSafe:true,reason:'test-only support',claims:[{text:'test-only claim',support:'supported',sourceSpans:['test-only source span']}],adjudicated:true,adjudicationReason:'test-only reviewed',disagreementResolved:true}))};
  return {manifest,samples,grades};
}
test('nearest rank retains censored +Infinity, not finite-only filtering', () => {
  assert.equal(nearestRank([...Array(37).fill(1),Infinity,Infinity,Infinity]),Infinity);
  assert.equal(nearestRank([...Array(38).fill(1),Infinity,Infinity]),1);
  assert.equal(nearestRank([NaN,1]),Infinity);
});
test('manifest locks exact cohort, roles, safety split and hashes', () => {
  const {manifest} = fixture(); assert.equal(validateManifest(manifest),manifest);
  assert.throws(() => validateManifest({...manifest,concurrency:1}));
  assert.throws(() => validateManifest({...manifest,workloadHash:digest('changed')}));
  assert.throws(() => validateManifest({...manifest,cases:manifest.cases.slice(1)}));
});
test('endpoint config refuses cleartext remote and embedded credentials', () => {
  const c = {coreUrl:'http://127.0.0.1:1',gatewayControlUrl:'http://localhost:2',inferenceControlUrl:'https://example.test',operatorToken:'x'.repeat(32),gatewayControlToken:'y'.repeat(32),inferenceControlToken:'z'.repeat(32)};
  assert.equal(validateConfig(c),c);
  assert.throws(() => validateConfig({...c,coreUrl:'http://example.test'}));
  assert.throws(() => validateConfig({...c,coreUrl:'https://secret@example.test'}));
});
test('joint quality/latency pass remains explicitly short of full completion', () => {
  const {manifest,samples,grades} = fixture(); const summary=summarizeCompletion(manifest,samples,grades);
  assert.equal(summary.qualityLatencyPassed,true); assert.equal(summary.fullCompletionProven,false);
  assert.equal(summarizeCompletion(manifest,samples).qualityLatencyPassed,false);
});
test('failed first pass cannot be rescued by repeated successes or denominator shrinking', () => {
  const {manifest,samples,grades} = fixture();
  samples.slice(0,3).forEach(s => {s.status='failed';s.hasFinal=false;s.elapsedMs=1;});
  const result=summarizeCompletion(manifest,samples,grades); assert.equal(result.finalResponseP95Ms,'Infinity'); assert.equal(result.gates.Q1,true); assert.equal(result.gates.P1,false);
  const repeats=samples.slice(0,3).map(s => ({...s,occurrence:2,status:'completed',hasFinal:true}));
  assert.equal(summarizeCompletion(manifest,[...samples,...repeats],grades).qualityLatencyPassed,false);
  assert.equal(summarizeCompletion(manifest,samples.slice(3),grades).primaryDenominator,40);
  assert.equal(summarizeCompletion(manifest,samples.slice(3),grades).complete,false);
});
test('fast refusals cannot manufacture useful success and drafts are graded', () => {
  const {manifest,samples,grades}=fixture(); grades.cases.slice(0,5).forEach(g => {g.U=false;});
  assert.equal(summarizeCompletion(manifest,samples,grades).gates.Q1,false);
  grades.cases[0].visibleClaimsSafe=false; assert.equal(summarizeCompletion(manifest,samples,grades).gates.Q3,false);
});
test('grades require bound transcripts/rubrics, different reviewers, claim spans and adjudication', () => {
  const {manifest,grades}=fixture(); assert.equal(validateGrades(grades,manifest,grades.samplesHash),grades);
  assert.throws(() => validateGrades(grades,manifest,digest('wrong')));
  assert.throws(() => validateGrades({...grades,graderId:'implementer'},manifest,grades.samplesHash));
  grades.cases[0].F=false; grades.cases[0].adjudicated=false;
  assert.throws(() => validateGrades(grades,manifest,grades.samplesHash));
});
test('one uncertain request globally closes admission while other backup requests finish', async () => {
  const {manifest}=fixture(); let admitted=0;
  const result=await runConcurrent(manifest.cases,async(c,stop) => {
    const index=admitted++;
    if (index===0) { await new Promise(r => setTimeout(r,2)); stop('unknown-backend-compute'); return {caseId:c.id,computeCompletionProven:false}; }
    await new Promise(r => setTimeout(r,10)); return {caseId:c.id,computeCompletionProven:true,backupSucceeded:true};
  });
  assert.equal(admitted,3); assert.equal(result.samples.length,3); assert.equal(result.stopReason,'unknown-backend-compute');
});
test('budget and external interruption prevent new submissions', async () => {
  const {manifest}=fixture(); let time=0,admitted=0;
  const result=await runConcurrent(manifest.cases,async() => {admitted++; return {computeCompletionProven:true};},{now:() => time++,wallMs:1});
  assert.equal(admitted,0); assert.equal(result.stopReason,'campaign-budget');
  const controller=new AbortController();controller.abort();
  assert.equal((await runConcurrent(manifest.cases,async()=>assert.fail(),{signal:controller.signal})).admitted,0);
});
test('verify reads immutable manifest/sample hashes and validated grades, never trusts saved summary', () => {
  const root=mkdtempSync(join(tmpdir(),'grounded-eval-'));
  try {
    const {manifest,samples,grades}=fixture(), mb=JSON.stringify(manifest), sb=samples.map(s=>JSON.stringify(s)).join('\n');
    grades.samplesHash=digest(sb);writeFileSync(join(root,'manifest.json'),mb);writeFileSync(join(root,'samples.jsonl'),sb);writeFileSync(join(root,'grades.json'),JSON.stringify(grades));
    const report={schemaVersion:'grounded-completion-report/v1',manifestFile:'manifest.json',manifestHash:digest(mb),samplesFile:'samples.jsonl',samplesHash:digest(sb),cleanup:[{faultsRestored:true,cancellationConfirmed:true,transportDrained:true}],summary:{qualityLatencyPassed:false}};
    writeFileSync(join(root,'report.json'),JSON.stringify(report));
    assert.equal(verifyReport(join(root,'report.json'),join(root,'grades.json')).passed,true);
    assert.equal(verifyReport(join(root,'report.json')).passed,false);
    writeFileSync(join(root,'samples.jsonl'),sb+' ');
    assert.throws(()=>verifyReport(join(root,'report.json'),join(root,'grades.json')));
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('actual client captures full SSE and latches unknown failed primary even after successful backup', async t => {
  const { executeCase } = await import('../scripts/evaluate-grounded-completion.mjs');
  const requestId='RUN-client-test', stops=[], active=new Map();
  const distributed={attempts:[{agentId:'tech',role:'primary',status:'failed',usageStatus:'unknown',reasonCode:'attempt-timeout',backend:null},{agentId:'tech',role:'backup',status:'succeeded',backend:'ollama',usageStatus:'measured'}],stages:[{stage:'synthesis',backend:'ollama'}],calls:[]};
  t.mock.method(globalThis,'fetch',async (input,options) => {
    const url=new URL(input);
    if (url.pathname==='/api/runs' && options.method==='POST') {
      assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(),['commercialJudge','mode','query']);
      return Response.json({requestId});
    }
    if (url.pathname.endsWith('/events')) return new Response('id: 1\nevent: progress\ndata: {"stage":"working"}\n\nid: 2\nevent: completed\ndata: {"answer":"visible"}\n\n');
    if (url.pathname==='/api/telemetry') return Response.json({runs:[{runId:requestId,distributed}],hasMore:false});
    return Response.json({status:'completed',executionSettled:true,result:{answer:'visible'}});
  });
  const result=await executeCase({coreUrl:'http://localhost:1',operatorToken:'private-token'}, {id:'case',query:'test question'},reason=>stops.push(reason),active,new AbortController().signal);
  assert.equal(result.transcript.length,2);assert.equal(result.transcriptComplete,true);
  assert.equal(result.hasFinal,true);assert.equal(result.computeCompletionProven,false);
  assert.deepEqual(stops,['residual-compute-unproven']);assert.equal(active.size,1);
});

test('interrupted SSE retains already visible events and stops instead of erasing the draft', async t => {
  const { executeCase } = await import('../scripts/evaluate-grounded-completion.mjs');
  const requestId='RUN-partial-transcript', stops=[];
  t.mock.method(globalThis,'fetch',async input => {
    const url=new URL(input);
    if (url.pathname==='/api/runs') return Response.json({requestId});
    if (url.pathname.endsWith('/events')) return new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('id: 1\nevent: progress\ndata: {"draft":"already visible"}\n\n'));
      setTimeout(()=>controller.error(new Error('test interruption')),5);
    }}));
    if (url.pathname==='/api/telemetry') return Response.json({runs:[{runId:requestId,distributed:{attempts:[],stages:[]}}],hasMore:false});
    return Response.json({status:'completed',executionSettled:true,result:{answer:'final'}});
  });
  const sample=await executeCase({coreUrl:'http://localhost:1',operatorToken:'private-token'},{id:'partial',query:'test'},r=>stops.push(r),new Map(),new AbortController().signal);
  assert.equal(sample.transcriptComplete,false);assert.equal(sample.transcript[0].data.draft,'already visible');
  assert.ok(stops.includes('transcript-incomplete'));assert.equal(sample.computeCompletionProven,false);
});

test('frozen rendering metadata distinguishes generation, extraction and unknown without claiming semantics', async t => {
  const { executeCase } = await import('../scripts/evaluate-grounded-completion.mjs');
  const requestId='RUN-rendering-metadata';
  t.mock.method(globalThis,'fetch',async input => {
    const url=new URL(input);
    if(url.pathname==='/api/runs')return Response.json({requestId});
    if(url.pathname.endsWith('/events'))return new Response('id: 1\nevent: completed\ndata: {"answer":"test"}\n\n');
    if(url.pathname==='/api/telemetry')return Response.json({runs:[{runId:requestId,distributed:{attempts:[],stages:[]}}],hasMore:false});
    return Response.json({status:'completed',executionSettled:true,result:{answer:'test'}});
  });
  const samples=[];
  for(const declaration of ['model-guided-extractive','source-grounded-generation','unrecognized',undefined]){
    const sample=await executeCase({coreUrl:'http://localhost:1',operatorToken:'private-token',frozenConfiguration:{answerRendering:declaration}}, {id:`render-${samples.length}`,query:'test'},()=>{},new Map(),new AbortController().signal);
    assert.equal(sample.answerRendering,['model-guided-extractive','source-grounded-generation'].includes(declaration)?declaration:null);
    assert.equal(sample.renderingProvenance,'frozen-configuration-not-semantic-classification');
    assert.deepEqual(sample.renderingConfiguration,{edge:null,core:null});
    assert.equal(sample.realInference,false);
    samples.push(sample);
  }
  const hybrid={edge:'model-guided-extractive',core:'source-grounded-generation'};
  const hybridSample=await executeCase({coreUrl:'http://localhost:1',operatorToken:'private-token',frozenConfiguration:{answerRendering:hybrid.core,renderingConfiguration:hybrid}}, {id:'hybrid',query:'test'},()=>{},new Map(),new AbortController().signal);
  assert.deepEqual(hybridSample.renderingConfiguration,hybrid);assert.equal(hybridSample.answerRendering,hybrid.core);
  const {manifest}=fixture(),summary=summarizeCompletion(manifest,samples);
  assert.equal(summary.outcomes.extractive,1);assert.equal(summary.outcomes.generated,1);assert.equal(summary.outcomes.renderingUnknown,2);
  assert.equal(summary.qualityLatencyPassed,false);assert.equal(summary.semanticReview,'pending');
});


test('hybrid declaration is explicit, validated and never inferred from final rendering', async()=>{
 const {renderingConfiguration,validateRenderingBinding}=await import('../scripts/evaluate-grounded-completion.mjs');
 const hybrid={edge:'model-guided-extractive',core:'source-grounded-generation'};
 assert.deepEqual(renderingConfiguration(undefined),{edge:null,core:null});
 assert.deepEqual(validateRenderingBinding({renderingConfiguration:hybrid},{renderingConfiguration:hybrid,answerRendering:hybrid.core}),hybrid);
 assert.deepEqual(validateRenderingBinding({},{answerRendering:hybrid.core}),{edge:null,core:null});
 for(const bad of ['generation',[],{edge:'anything'},{core:true},{edge:'model-guided-extractive',replicas:'same'}]) assert.throws(()=>renderingConfiguration(bad));
 assert.throws(()=>validateRenderingBinding({renderingConfiguration:hybrid},{}));
 assert.throws(()=>validateRenderingBinding({renderingConfiguration:hybrid},{renderingConfiguration:hybrid,answerRendering:hybrid.edge}));
 const {manifest}=fixture(),summary=summarizeCompletion({...manifest,renderingConfiguration:hybrid},[{answerRendering:hybrid.core}]);
 assert.deepEqual(summary.renderingConfiguration,hybrid);assert.equal(summary.outcomes.generated,1);assert.equal(summary.outcomes.extractive,0);assert.equal(summary.fullCompletionProven,false);
});
