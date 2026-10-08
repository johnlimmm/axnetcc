import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, finalizeAccounting } from '../scripts/evaluate-grounded-completion.mjs';
import { scenarios, validateRecoveryManifest, validateBudget, recoveryComputeRisk, controlScenario, runRecovery, summarizeRecovery } from '../scripts/evaluate-distributed-recovery.mjs';
const roles=['tech','data','security','legal','policy','finance','procurement','operations'];
function fixture(){
 const cases=roles.flatMap(role=>[0,1].map(i=>({id:`${role}-${i}`,role,query:`test-only ${role} ${i}`})));
 const manifest={schemaVersion:'distributed-recovery/v1',deploymentId:'test',seed:23,frozenAt:'2020-01-01T00:00:00Z',concurrency:3,maximumRequests:112,deadlineMs:60000,scenarios,cases,workloadHash:digest(JSON.stringify(cases)),configurationHash:digest('config'),artifacts:[{path:'test-receipt',sha256:digest('receipt')}],coreNode:'core-test',topology:roles.map(role=>({role,primaryNode:'first-test',backupNode:'second-test'}))};
 const config={coreUrl:'http://127.0.0.1:1',baselineUrl:'http://127.0.0.1:2',gatewayControlUrl:'http://127.0.0.1:3',inferenceControlUrl:'http://127.0.0.1:4',operatorToken:'operator-secret-123',baselineToken:'baseline-secret-123',gatewayControlToken:'gateway-secret-123',inferenceControlToken:'inference-secret-123'};
 const budget={campaignId:'shared-test',startedAtMs:100000,usedRequests:50,maximumRequests:180,maximumWallMs:7200000};
 const lease=scenario=>({scenario,issuedAt:100000,expiresAt:280000,authenticated:true,routeScenario:['primary-down','backup-down','both-down'].includes(scenario)?scenario:'healthy',inferenceUnavailable:scenario==='inference-down'});
 const attempt=(overrides={})=>({attemptId:'attempt',agentId:'tech',nodeId:'first-test',role:'primary',startedAt:100000,completedAt:100001,status:'failed',reasonCode:'edge-unavailable',backend:null,promptTokens:null,completionTokens:null,usageStatus:'unknown',adopted:false,...overrides});
 const sample=(scenario='primary-down',overrides={})=>({caseId:'tech-0',scenario,submittedAtMs:100000,observedAtMs:100002,reason:null,distributed:{attempts:[attempt()],calls:[],totals:{promptTokens:null,completionTokens:null,knownPromptTokens:0,knownCompletionTokens:0}},...overrides});
 return {manifest,config,budget,lease,attempt,sample};
}
test('recovery manifest fixes sixteen balanced cases, seven scenarios and shared 180/2h budget',()=>{
 const {manifest,budget}=fixture();assert.equal(validateRecoveryManifest(manifest),manifest);assert.equal(validateBudget(budget,100000),budget);
 assert.throws(()=>validateRecoveryManifest({...manifest,cases:manifest.cases.slice(1)}));
 assert.throws(()=>validateRecoveryManifest({...manifest,scenarios:scenarios.slice(1)}));
 assert.throws(()=>validateBudget({...budget,usedRequests:69},100000));
 assert.throws(()=>validateBudget(budget,7300000));
});
test('controlled rejection needs authenticated complete lease, correct node/role and exact code',()=>{
 const {manifest,lease,attempt,sample}=fixture();const s=sample();
 assert.equal(recoveryComputeRisk(s,lease('primary-down'),manifest),false);
 for(const bad of [null,{...lease('primary-down'),authenticated:false},{...lease('primary-down'),expiresAt:100001},{...lease('primary-down'),issuedAt:100001}])assert.equal(recoveryComputeRisk(s,bad,manifest),true);
 for(const a of [attempt({role:'backup',nodeId:'second-test'}),attempt({nodeId:'untrusted'}),attempt({reasonCode:'http-403'}),attempt({reasonCode:'connection-unavailable'}),attempt({startedAt:99999}),attempt({completedAt:280000})])assert.equal(recoveryComputeRisk({...s,distributed:{attempts:[a],calls:[]}},lease('primary-down'),manifest),true);
});
test('successful backup cannot hide unknown primary; inference rejection only in its active scenario',()=>{
 const {manifest,lease,attempt,sample}=fixture();
 const backup=attempt({attemptId:'backup',role:'backup',nodeId:'second-test',backend:'ollama',status:'succeeded',reasonCode:null,adopted:true});
 const unknown=sample('primary-down',{distributed:{attempts:[attempt({reasonCode:'attempt-timeout'}),backup],calls:[]}});
 assert.equal(recoveryComputeRisk(unknown,lease('primary-down'),manifest),true);
 const inferred=sample('inference-down',{distributed:{attempts:[attempt({reasonCode:'inference-unavailable'}),backup],calls:[]}});
 assert.equal(recoveryComputeRisk(inferred,lease('inference-down'),manifest),false);
 assert.equal(recoveryComputeRisk({...inferred,scenario:'healthy-backup-enabled'},lease('healthy-backup-enabled'),manifest),true);
});
test('both-down can prove no compute only with rejected attempts and no generated synthesis',()=>{
 const {manifest,lease,attempt,sample}=fixture();const s=sample('both-down',{distributed:{attempts:[attempt(),attempt({attemptId:'b',role:'backup',nodeId:'second-test'})],calls:[]}});
 assert.equal(recoveryComputeRisk(s,lease('both-down'),manifest),false);
 assert.equal(recoveryComputeRisk({...s,distributed:{...s.distributed,calls:[{backend:'deterministic'}]}},lease('both-down'),manifest),true);
 const rows=manifest.cases.map(c=>({...s,caseId:c.id,status:'failed',hasFinal:false,computeCompletionProven:true,transcriptComplete:true,elapsedMs:20,accountingFinalization:{status:'final-ledger-observed'}}));
 assert.equal(summarizeRecovery(manifest,rows)['both-down'].bothDownNoSynthesis,true);
 assert.equal(summarizeRecovery(manifest,rows.slice(1))['both-down'].complete,false);
});
test('fault acknowledgement and TTL are validated without trusting a generic success HTTP',async()=>{
 const {config}=fixture();const seen=[];
 const lease=await controlScenario(config,'primary-down',{now:()=>100000,request:async(url,token,opt)=>{seen.push(JSON.parse(opt.body));return url.pathname==='/fault'?{scenario:'primary-down',agentId:'all',expiresAt:280000}:{unavailable:false,expiresAt:0};}});
 assert.equal(lease.expiresAt,280000);assert.equal(seen[0].ttlMs,180000);
 await assert.rejects(()=>controlScenario(config,'primary-down',{now:()=>100000,request:async()=>({scenario:'healthy',unavailable:false})}));
});
function dependencies(f,options={}){
 let current,seq=0;const calls=[],cleanupCalls=[];
 return {calls,cleanupCalls,now:()=>100000,renewEveryMs:options.renewEveryMs??60000,
  control:async(_cfg,scenario)=>{current=scenario;return f.lease(scenario);},
  snapshot:async()=>({status:'completed',executionSettled:true}),
  cleanup:async(_cfg,run)=>{cleanupCalls.push(run);return {faultsRestored:true,cancellationConfirmed:true,transportDrained:true};},
  execute:async(cfg,c,stop,active)=>{
   const requestId=`RUN-${seq++}`;calls.push({scenario:current,id:c.id,url:cfg.coreUrl});active.set(requestId,{coreUrl:cfg.coreUrl,token:cfg.operatorToken,requestId});
   if(options.delay)await new Promise(r=>setTimeout(r,options.delay));
   const fault=['primary-down','inference-down','both-down'].includes(current);
   const a=f.attempt({agentId:c.role,startedAt:100000,completedAt:100000,reasonCode:current==='inference-down'?'inference-unavailable':'edge-unavailable'});
   const success=f.attempt({attemptId:'success',agentId:c.role,status:'succeeded',backend:'ollama',promptTokens:7,completionTokens:3,reasonCode:null,usageStatus:'measured',adopted:true,startedAt:100000,completedAt:100000,...(fault?{role:'backup',nodeId:'second-test'}:{})});
   const attempts=current==='both-down'?[a,{...a,attemptId:'backup',role:'backup',nodeId:'second-test'}]:fault?[a,success]:[success];
   if(options.unknown && current==='healthy-backup-disabled'){attempts.unshift({...a,reasonCode:'attempt-timeout'});stop('residual-compute-unproven');}
   if(fault)stop('residual-compute-unproven');
   return {caseId:c.id,occurrence:1,requestId,status:current==='both-down'?'failed':'completed',hasFinal:current!=='both-down',transcriptComplete:true,transcript:[{id:1}],reason:null,elapsedMs:10,realInference:current!=='both-down',computeCompletionProven:!fault,distributed:{attempts,calls:[],stages:[],totals:{promptTokens:fault?null:7,completionTokens:fault?null:3,knownPromptTokens:current==='both-down'?0:7,knownCompletionTokens:current==='both-down'?0:3}}};
  },
  finalize:async(cfg,rows)=>finalizeAccounting(cfg,rows,{readLedger:async id=>rows.find(r=>r.requestId===id).distributed,readSnapshot:async()=>({status:'completed',executionSettled:true})}),
 };
}
test('112 mock requests use identical per-scenario order, concurrency3, baseline config and restored cleanup',async()=>{
 const f=fixture(),deps=dependencies(f),report=await runRecovery(f.manifest,f.config,f.budget,deps);
 assert.equal(report.initialSamples.length,112);assert.equal(report.finalSamples.length,112);assert.equal(report.status,'measured-awaiting-semantic-review');
 assert.equal(report.budget.usedRequestsAfter,162);assert.equal(report.fullCompletionProven,false);
 const order=deps.calls.slice(0,16).map(c=>c.id);
 for(let i=0;i<7;i++)assert.deepEqual(deps.calls.slice(i*16,i*16+16).map(c=>c.id),order);
 assert.equal(deps.calls[0].url,f.config.baselineUrl);assert.equal(deps.calls[16].url,f.config.coreUrl);
 assert.equal(report.finalSamples.find(s=>s.scenario==='primary-down').healthyPolicyComputeCompletionProven,false);
 assert.equal(report.finalSamples.find(s=>s.scenario==='primary-down').computeCompletionProven,true);
 assert.equal(report.summary['both-down'].bothDownNoSynthesis,true);assert.ok(deps.cleanupCalls.length);
});
test('unknown primary halts all clients, retains incomplete rows, never upgrades from late measured counters',async()=>{
 const f=fixture(),deps=dependencies(f,{unknown:true}),report=await runRecovery(f.manifest,f.config,f.budget,deps);
 assert.equal(report.status,'incomplete');assert.ok(report.budget.admittedThisRun<=3);assert.ok(report.initialSamples.length>0);
 assert.ok(report.finalSamples.every(s=>s.computeCompletionProven===false));assert.ok(deps.cleanupCalls.some(Boolean));
});
test('late ledger records and nullable totals survive scenario finalization',async()=>{
 const f=fixture(),deps=dependencies(f);
 deps.finalize=async(cfg,rows)=>finalizeAccounting(cfg,rows,{readSnapshot:async()=>({status:'completed',executionSettled:true}),readLedger:async id=>{
  const ledger=structuredClone(rows.find(r=>r.requestId===id).distributed);ledger.calls.push({callId:'late',stage:'synthesis',backend:'ollama',promptTokens:null,completionTokens:null});ledger.totals.promptTokens=null;ledger.totals.completionTokens=null;return ledger;
 }});
 const report=await runRecovery(f.manifest,f.config,f.budget,deps);
 assert.equal(report.finalSamples[0].distributed.calls.length,1);assert.equal(report.finalSamples[0].distributed.totals.promptTokens,null);
 assert.equal(report.summary['healthy-backup-disabled'].promptTokens,null);assert.equal(report.summary['healthy-backup-disabled'].knownPromptTokens,112);
});
test('renewal failure stops admission and awaits owned cleanup, never silently resumes',async()=>{
 const f=fixture(),deps=dependencies(f,{delay:10,renewEveryMs:2});let renews=0;
 deps.control=async()=>{if(renews++)throw new Error('test renewal failed');return f.lease('healthy-backup-disabled');};
 const report=await runRecovery(f.manifest,f.config,f.budget,deps);
 assert.equal(report.stopReason,'fault-renewal-failed');assert.ok(report.budget.admittedThisRun<=3);assert.ok(deps.cleanupCalls.length);
});

test('post-cleanup reread retains newly observed abandoned cost without upgrading initial uncertainty',async()=>{
 const f=fixture(),deps=dependencies(f,{unknown:true});let cleaned=false;
 deps.cleanup=async()=>{cleaned=true;return {faultsRestored:true,cancellationConfirmed:true,transportDrained:true};};
 deps.finalize=async(cfg,rows)=>finalizeAccounting(cfg,rows,{readSnapshot:async()=>({status:'cancelled',executionSettled:cleaned}),readLedger:async id=>{
  const ledger=structuredClone(rows.find(r=>r.requestId===id).distributed);
  if(cleaned){ledger.calls.push({callId:'late-abandoned',stage:'synthesis',backend:'ollama',promptTokens:11,completionTokens:5});ledger.totals.knownPromptTokens+=11;ledger.totals.knownCompletionTokens+=5;}
  ledger.totals.promptTokens=null;ledger.totals.completionTokens=null;return ledger;
 }});
 const report=await runRecovery(f.manifest,f.config,f.budget,deps);
 assert.equal(report.finalSamples[0].distributed.calls[0].callId,'late-abandoned');
 assert.equal(report.finalSamples[0].distributed.totals.knownPromptTokens,18);
 assert.equal(report.finalSamples[0].distributed.totals.promptTokens,null);
 assert.equal(report.finalSamples[0].computeCompletionProven,false);
});


test('finalized invalid Edge output proves only compute and requires strict proof and existing identity/lease checks',()=>{
 const {manifest,lease,attempt,sample}=fixture(), scenario='healthy-backup-enabled';
 const invalid=attempt({backend:'ollama',reasonCode:'inference-invalid',providerFinalObserved:true,promptTokens:12,completionTokens:4});
 const row=sample(scenario,{status:'failed',hasFinal:false,realInference:false,distributed:{attempts:[invalid],calls:[]}});
 assert.equal(recoveryComputeRisk(row,lease(scenario),manifest),false);
 assert.equal(row.status,'failed');assert.equal(row.hasFinal,false);assert.equal(invalid.adopted,false);
 for(const patch of [{providerFinalObserved:false},{providerFinalObserved:undefined},{providerFinalObserved:'true'},{adopted:true},{status:'cancelled'},{reasonCode:'attempt-timeout'},{reasonCode:'http-403'},{backend:null},{nodeId:'untrusted'},{completedAt:280000}]){
  assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[{...invalid,...patch}],calls:[]}},lease(scenario),manifest),true,JSON.stringify(patch));
 }
 assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[invalid,attempt({reasonCode:'connection-unavailable'})],calls:[]}},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk({...row,cancellationRequested:true},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk({...row,distributed:{...row.distributed,accountingIncomplete:true}},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk(row,{...lease(scenario),authenticated:false},manifest),true);
});

test('Core failed invalid-response needs strict final proof; cancellation, uncertain calls and legacy aggregates remain unsafe',()=>{
 const {manifest,lease,sample}=fixture(), scenario='healthy-backup-enabled';
 const call={backend:'deterministic',status:'failed',failureCode:'invalid-response',providerFinalObserved:true};
 const row=sample(scenario,{status:'failed',hasFinal:false,distributed:{attempts:[],calls:[call]}});
 assert.equal(recoveryComputeRisk(row,lease(scenario),manifest),false);
 for(const patch of [{providerFinalObserved:false},{providerFinalObserved:undefined},{providerFinalObserved:'true'},{failureCode:'connection'},{failureCode:'timeout'},{failureCode:'provider-error'},{status:'cancelled'},{status:'succeeded'},{backend:null}]){
  assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[],calls:[{...call,...patch}]}},lease(scenario),manifest),true,JSON.stringify(patch));
 }
 assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[],calls:[call,{backend:'ollama',status:'cancelled'}]}},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[],calls:[call,{backend:'deterministic',status:'failed',failureCode:'timeout'}]}},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[],calls:[call],accountingIncomplete:true}},lease(scenario),manifest),true);
 assert.equal(recoveryComputeRisk({...row,distributed:{attempts:[],calls:[],stages:[call]}},lease(scenario),manifest),true);
});
