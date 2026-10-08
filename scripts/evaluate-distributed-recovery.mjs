import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, nearestRank, validateConfig, renderingConfiguration, validateRenderingBinding, executeCase, runConcurrent, finalizeAccounting } from './evaluate-grounded-completion.mjs';
import { cleanupCampaign, installCampaignInterrupts } from './benchmark-distributed-demo.mjs';

export const scenarios = ['healthy-backup-disabled','healthy-backup-enabled','primary-down','inference-down','backup-down','both-down','restored-primary'];
const roles = ['tech','data','security','legal','policy','finance','procurement','operations'];
const terminal = new Set(['completed','partial_failed','failed','cancelled']);
const fail = message => { throw new Error(message); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
export function validateRecoveryManifest(m) {
  renderingConfiguration(m.renderingConfiguration);
  if (m.schemaVersion !== 'distributed-recovery/v1' || !id(m.deploymentId) || !Number.isSafeInteger(m.seed) || !Number.isFinite(Date.parse(m.frozenAt)) || Date.parse(m.frozenAt) > Date.now()) fail('Invalid frozen manifest');
  if (m.concurrency !== 3 || m.maximumRequests !== 112 || m.deadlineMs !== 60000 || JSON.stringify(m.scenarios) !== JSON.stringify(scenarios)) fail('Fixed recovery protocol required');
  if (!Array.isArray(m.cases) || m.cases.length !== 16 || new Set(m.cases.map(c=>c.id)).size !== 16 || new Set(m.cases.map(c=>c.query)).size !== 16) fail('Sixteen distinct questions required');
  for (const c of m.cases) if (!id(c.id) || !roles.includes(c.role) || typeof c.query !== 'string' || !c.query.trim() || c.query.length>10000) fail('Invalid question');
  for (const role of roles) if (m.cases.filter(c=>c.role===role).length!==2) fail('Two questions per role required');
  if (!Array.isArray(m.topology) || m.topology.length!==8 || !id(m.coreNode)) fail('Explicit topology required');
  for (const role of roles) {
    const entries=m.topology.filter(t=>t.role===role);
    if (entries.length!==1 || !id(entries[0].primaryNode) || !id(entries[0].backupNode) || entries[0].primaryNode===entries[0].backupNode) fail('Role topology invalid');
  }
  if (!hash(m.workloadHash) || m.workloadHash!==digest(JSON.stringify(m.cases)) || !hash(m.configurationHash)) fail('Frozen workload/config hash mismatch');
  if (!Array.isArray(m.artifacts) || !m.artifacts.length || m.artifacts.some(a=>typeof a.path!=='string' || !hash(a.sha256))) fail('Frozen artifact hashes required');
  return m;
}
export function validateBudget(budget, now=Date.now()) {
  if (!id(budget.campaignId) || !Number.isFinite(budget.startedAtMs) || budget.startedAtMs>now || now-budget.startedAtMs>=7200000 || !Number.isSafeInteger(budget.usedRequests) || budget.usedRequests<0 || budget.usedRequests+112>180 || budget.maximumRequests!==180 || budget.maximumWallMs!==7200000) fail('Shared campaign budget exhausted or invalid');
  return budget;
}
function recoveryConfig(config) {
  validateConfig(config);
  validateConfig({...config,coreUrl:config.baselineUrl,operatorToken:config.baselineToken});
  if (config.faultAgentId && config.faultAgentId!=='all') fail('Balanced campaign faults all roles');
  return config;
}
async function call(url,token,options={}) {
  const response=await fetch(url,{...options,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},signal:AbortSignal.timeout(10000)});
  if (!response.ok) fail('Control or collection request failed');
  return response.json();
}
export async function controlScenario(config,scenario,{now=Date.now,request=call}={}) {
  const routeScenario=['primary-down','backup-down','both-down'].includes(scenario)?scenario:'healthy';
  const issuedAt=now(), unavailable=scenario==='inference-down';
  const route=await request(new URL('/fault',config.gatewayControlUrl),config.gatewayControlToken,{method:'POST',body:JSON.stringify({scenario:routeScenario,agentId:'all',ttlMs:180000})});
  const inference=await request(new URL('/__control',config.inferenceControlUrl),config.inferenceControlToken,{method:'POST',body:JSON.stringify({unavailable,ttlMs:180000})});
  if (route.scenario!==routeScenario || (route.agentId!==undefined && route.agentId!=='all') || inference.unavailable!==unavailable) fail('Controller did not acknowledge requested fault');
  const expiresAt=Math.min(issuedAt+180000,routeScenario==='healthy'?Infinity:route.expiresAt,unavailable?inference.expiresAt:Infinity);
  if (!Number.isFinite(expiresAt) || expiresAt-now()<90000) fail('Fault lease insufficient');
  return {scenario,routeScenario,inferenceUnavailable:unavailable,issuedAt,expiresAt,authenticated:true};
}
/** Completed provider output and exact controlled rejection are separate compute proofs. */
export function recoveryComputeRisk(sample,lease,manifest) {
  if (sample.reason || sample.cancellationRequested || !sample.distributed || sample.distributed.accountingIncomplete === true || !lease?.authenticated || sample.scenario!==lease.scenario || !Number.isFinite(sample.submittedAtMs) || !Number.isFinite(sample.observedAtMs) || sample.submittedAtMs<lease.issuedAt || sample.observedAtMs>=lease.expiresAt) return true;
  for (const a of sample.distributed.attempts??[]) {
    const node=manifest.topology.find(t=>t.role===a.agentId);
    if (!node || !['primary','backup'].includes(a.role) || a.nodeId!==node[`${a.role}Node`]) return true;
    if (a.usageStatus==='not-started') continue;
    if (!Number.isFinite(a.startedAt) || !Number.isFinite(a.completedAt) || a.startedAt<lease.issuedAt || a.completedAt<a.startedAt || a.completedAt>=lease.expiresAt) return true;
    if (a.status==='succeeded' && a.backend==='ollama') continue;
    if (a.status==='failed' && a.adopted===false && a.backend==='ollama' && a.reasonCode==='inference-invalid' && a.providerFinalObserved===true) continue;
    if (a.status!=='failed' || a.backend!==null || a.promptTokens!==null || a.completionTokens!==null) return true;
    const routeBlocked=lease.routeScenario==='both-down' || lease.routeScenario===`${a.role}-down`;
    const knownRoute=routeBlocked && a.reasonCode==='edge-unavailable';
    const knownInference=lease.inferenceUnavailable && a.role==='primary' && a.reasonCode==='inference-unavailable';
    if (!knownRoute && !knownInference) return true;
  }
  if (Array.isArray(sample.distributed.calls) && sample.distributed.calls.length) {
    return sample.distributed.calls.some(c=>c.status==='cancelled' || (c.backend!=='ollama' &&
      !(c.backend==='deterministic' && c.status==='failed' && c.failureCode==='invalid-response' && c.providerFinalObserved===true)));
  }
  return (sample.distributed.stages??[]).some(c=>c.backend!=='ollama');
}
export function summarizeRecovery(manifest,samples) {
  const metric=(values,probability=.95)=>{const p=nearestRank(values,probability);return p===Infinity?'Infinity':p;};
  return Object.fromEntries(scenarios.map(scenario=>{
    const rows=samples.filter(s=>s.scenario===scenario), expected=manifest.cases.map(c=>rows.find(s=>s.caseId===c.id));
    const attempts=rows.flatMap(s=>s.distributed?.attempts??[]);
    const recovered=rows.filter(s=>(s.distributed?.attempts??[]).some(a=>a.role==='backup' && a.adopted && a.backend==='ollama'));
    const success=rows.filter(s=>s.status==='completed' && s.hasFinal && s.realInference);
    const known=(key)=>rows.reduce((n,s)=>n+(s.distributed?.totals?.[key]??0),0);
    const complete=rows.length===16 && new Set(rows.map(s=>s.caseId)).size===16 && rows.every(s=>s.accountingFinalization?.status==='final-ledger-observed' && s.computeCompletionProven && s.transcriptComplete);
    const allKnown=rows.length===16 && rows.every(s=>Number.isSafeInteger(s.distributed?.totals?.promptTokens) && Number.isSafeInteger(s.distributed?.totals?.completionTokens));
    return [scenario,{planned:16,admitted:rows.length,complete,completed:rows.filter(s=>s.status==='completed').length,realInferenceResponses:success.length,recoveredResponses:recovered.length,
      failedOrPartial:rows.filter(s=>s.status!=='completed').length,unknownCompute:rows.filter(s=>!s.computeCompletionProven).length,
      allTerminalP50Ms:metric(expected.map(s=>s&&terminal.has(s.status)?s.elapsedMs:Infinity),.5),successfulAnswerP50Ms:success.length?metric(success.map(s=>s.elapsedMs),.5):null,
      allTerminalP95Ms:metric(expected.map(s=>s&&terminal.has(s.status)?s.elapsedMs:Infinity)),successfulAnswerP95Ms:success.length?metric(success.map(s=>s.elapsedMs)):null,
      bothDownNoSynthesis:scenario==='both-down'?rows.length===16&&rows.every(s=>!s.hasFinal&&(s.distributed?.calls??s.distributed?.stages??[]).length===0):null,
      promptTokens:allKnown?known('knownPromptTokens'):null,completionTokens:allKnown?known('knownCompletionTokens'):null,knownPromptTokens:known('knownPromptTokens'),knownCompletionTokens:known('knownCompletionTokens'),
      attempts:attempts.length,semanticReview:'pending-independent-visible-transcript-review',qualityGate:'diagnostic-not-16-of-16-semantic-gate'}];
  }));
}
export async function runRecovery(manifest,config,budget,{
  now=Date.now,execute=executeCase,finalize=finalizeAccounting,control=controlScenario,cleanup=cleanupCampaign,
  snapshot=(cfg,requestId)=>call(new URL(`/api/runs/${requestId}`,cfg.coreUrl),cfg.operatorToken),
  onSample=()=>{},onFinal=()=>{},onReceipt=()=>{},signal,renewEveryMs=60000,
}={}) {
  validateRecoveryManifest(manifest);validateBudget(budget,now());recoveryConfig(config);validateRenderingBinding(manifest,config.frozenConfiguration);
  const controller=new AbortController(), active=new Map(), samples=[], finalized=[], receipts=[], cleanups=[];
  let stopReason=null, admitted=0, interruption=null;
  const stop=reason=>{stopReason??=reason;controller.abort();};
  const remove=installCampaignInterrupts(controller,name=>{interruption=name;stop('interrupted');});
  const interrupt=()=>stop('interrupted');signal?.addEventListener('abort',interrupt,{once:true});if(signal?.aborted)interrupt();
  const remaining=budget.startedAtMs+7200000-now(), deadline=setTimeout(()=>stop('shared-wall-budget'),Math.max(1,remaining));deadline.unref();
  const ordered=[...manifest.cases].sort((a,b)=>digest(`${manifest.seed}:${a.id}`).localeCompare(digest(`${manifest.seed}:${b.id}`)));
  try {
    for(const scenario of scenarios) {
      if(stopReason)break;
      const cfg=scenario==='healthy-backup-disabled'?{...config,coreUrl:config.baselineUrl,operatorToken:config.baselineToken,telemetryToken:config.baselineTelemetryToken??config.baselineToken}:config;
      let lease=await control(config,scenario,{now}), renewal=null, busy=false, ended=false;
      receipts.push(lease);onReceipt(lease);
      const renew=async()=>{
        if(ended||stopReason||busy)return;
        busy=true;
        try {
          if(now()+30000>=lease.expiresAt){stop('fault-lease-expiring');return;}
          const next=await control(config,scenario,{now});
          if(ended||stopReason)return;
          // Coverage is continuous only when renewal acknowledges before the old lease expires.
          if(now()>=lease.expiresAt){stop('fault-lease-gap');return;}
          lease=next;receipts.push(next);onReceipt(next);
        }catch{stop('fault-renewal-failed');}finally{busy=false;}
      };
      const renewTimer=setInterval(()=>{if(!busy)renewal=renew();},renewEveryMs);renewTimer.unref();
      let rows=[];
      try {
        const result=await runConcurrent(ordered,async(c,latch)=>{
          if(stopReason||now()+70000>=lease.expiresAt||now()>=budget.startedAtMs+7200000||budget.usedRequests+admitted>=180){latch('admission-budget-or-lease');stop('admission-budget-or-lease');throw new Error('Admission closed');}
          admitted++;const submittedAtMs=now(), firstLease=lease;
          const deferred=[];
          const raw=await execute(cfg,c,reason=>{if(reason==='residual-compute-unproven')deferred.push(reason);else{latch(reason);stop(reason);}},active,controller.signal);
          const observedAtMs=now();
          // A request spanning renewals uses only the verified continuous coverage window.
          const proof={...firstLease,expiresAt:lease.expiresAt};
          const riskBeforeCollection=recoveryComputeRisk({...raw,scenario,submittedAtMs,observedAtMs},proof,manifest);
          if(riskBeforeCollection){latch('residual-compute-unproven');stop('residual-compute-unproven');}
          let settled=false;try{const state=await snapshot(cfg,raw.requestId);settled=state.executionSettled===true&&terminal.has(state.status);}catch{ /* Explicitly unknown. */ }
          const row={...raw,healthyPolicyComputeCompletionProven:raw.computeCompletionProven,scenario,submittedAtMs,observedAtMs,executionSettledObserved:settled,faultLease:proof};
          row.computeCompletionProven=settled&&raw.transcriptComplete&&!recoveryComputeRisk(row,proof,manifest);
          row.scenarioResidualPolicyApplied=deferred.length>0;
          if(row.computeCompletionProven)active.delete(raw.requestId);else{latch('residual-compute-unproven');stop('residual-compute-unproven');}
          return row;
        },{signal:controller.signal,wallMs:Math.max(0,budget.startedAtMs+7200000-now()),onSample:sample=>{sample.scenario??=scenario;sample.occurrence??=1;samples.push(sample);onSample(sample);}});
        rows=result.samples; if(result.stopReason)stop(result.stopReason);
      }finally{ended=true;clearInterval(renewTimer);if(renewal)await renewal;}
      // Preserve late counters; never turn an initially uncertain backend into a proven one.
      const collected=await finalize(cfg,rows);
      for(let i=0;i<collected.length;i++){
        const row=collected[i],initial=rows[i];
        row.computeCompletionProven=initial.computeCompletionProven===true&&row.accountingFinalization?.ledgerObserved===true&&row.accountingFinalization?.transportSettled===true&&!recoveryComputeRisk(row,initial.faultLease,manifest);
        if(!row.computeCompletionProven)stop('final-accounting-or-compute-unproven');
        finalized.push(row);
      }
    }
  }catch{stop('campaign-control-or-collection-failure');}
  finally{
    cleanups.push(...await Promise.all([...active.values()].map(run=>cleanup(config,run).catch(()=>({faultsRestored:false,cancellationConfirmed:false,transportDrained:false})))));
    cleanups.push(await cleanup(config,null).catch(()=>({faultsRestored:false,cancellationConfirmed:false,transportDrained:false})));
    clearTimeout(deadline);remove();signal?.removeEventListener('abort',interrupt);
  }
  // Cleanup can settle abandoned attempts and expose additional counters. Re-read only
  // unresolved rows, preserving their initial uncertainty and immutable client data.
  if(stopReason)for(const scenario of scenarios){
    const unresolved=samples.filter(s=>s.scenario===scenario&&!finalized.some(f=>f.scenario===scenario&&f.caseId===s.caseId&&f.computeCompletionProven));
    if(!unresolved.length)continue;
    const cfg=scenario==='healthy-backup-disabled'?{...config,coreUrl:config.baselineUrl,operatorToken:config.baselineToken,telemetryToken:config.baselineTelemetryToken??config.baselineToken}:config;
    let collected;
    try{collected=await finalize(cfg,unresolved);}catch{collected=unresolved.map(s=>({...s,distributed:s.distributed?{...s.distributed,totals:{...s.distributed.totals,promptTokens:null,completionTokens:null}}:null,computeCompletionProven:false,accountingFinalization:{status:'unproved',ledgerObserved:false,transportSettled:false}}));}
    for(const row of collected){
      row.computeCompletionProven=false; // Never upgrade an interrupted/uncertain observation.
      const index=finalized.findIndex(f=>f.scenario===row.scenario&&f.caseId===row.caseId);
      if(index<0)finalized.push(row);else finalized[index]=row;
    }
  }
  for(const row of finalized)onFinal(row);
  const summary=summarizeRecovery(manifest,finalized), restored=cleanups.length>0&&cleanups.every(c=>c.faultsRestored&&c.cancellationConfirmed&&c.transportDrained);
  return {renderingConfiguration:renderingConfiguration(manifest.renderingConfiguration),renderingProvenance:'frozen-configuration-not-per-call-observation',schemaVersion:'distributed-recovery-report/v1',status:!stopReason&&restored&&finalized.length===112?'measured-awaiting-semantic-review':'incomplete',stopReason,interruption,
    budget:{...budget,admittedThisRun:admitted,usedRequestsAfter:budget.usedRequests+admitted,elapsedSinceSharedStartMs:now()-budget.startedAtMs},summary,cleanup:cleanups,receipts,
    initialSamples:samples,finalSamples:finalized,fullCompletionProven:false,remainingEvidence:['independent semantic/Q3 review','actual owned Agent/model stops','cold/cancellation probes','browser and final review']};
}
async function main(args){
  const flags={};for(let i=0;i<args.length;i+=2){if(!['--manifest','--config','--budget','--output'].includes(args[i])||!args[i+1]||flags[args[i]])fail('Invalid flags');flags[args[i]]=args[i+1];}
  if(Object.keys(flags).length!==4||!isAbsolute(flags['--config']))fail('Manifest/private config/shared budget/new output required');
  const manifestPath=resolve(flags['--manifest']),m=validateRecoveryManifest(JSON.parse(readFileSync(manifestPath,'utf8'))),config=recoveryConfig(JSON.parse(readFileSync(flags['--config'],'utf8'))),budget=validateBudget(JSON.parse(readFileSync(flags['--budget'],'utf8')));
  if(digest(JSON.stringify(config.frozenConfiguration))!==m.configurationHash)fail('Configuration hash mismatch');
  for(const a of m.artifacts)if(digest(readFileSync(resolve(dirname(manifestPath),a.path)))!==a.sha256)fail('Artifact changed');
  const output=resolve(flags['--output']);mkdirSync(output);
  const secrets=Object.entries(config).filter(([k,v])=>/token|secret|password/i.test(k)&&typeof v==='string').map(([,v])=>v);
  const safe=v=>JSON.parse(secrets.reduce((text,secret)=>text.split(secret).join('[REDACTED]'),JSON.stringify(v)));
  writeFileSync(resolve(output,'manifest.json'),JSON.stringify(m,null,2));writeFileSync(resolve(output,'budget.json'),JSON.stringify(budget,null,2));
  for(const name of ['samples.jsonl','samples-final.jsonl','fault-receipts.jsonl'])writeFileSync(resolve(output,name),'');
  const append=(name,row)=>appendFileSync(resolve(output,name),JSON.stringify(safe(row))+'\n');
  const report=await runRecovery(m,config,budget,{onSample:r=>append('samples.jsonl',r),onFinal:r=>append('samples-final.jsonl',r),onReceipt:r=>append('fault-receipts.jsonl',r)});
  delete report.initialSamples;delete report.finalSamples;
  report.artifactHashes=Object.fromEntries(['manifest.json','budget.json','samples.jsonl','samples-final.jsonl','fault-receipts.jsonl'].map(name=>[name,digest(readFileSync(resolve(output,name)))]));
  writeFileSync(resolve(output,'report.json'),JSON.stringify(safe(report),null,2));console.log(JSON.stringify({status:report.status,budget:report.budget,fullCompletionProven:false}));process.exitCode=report.status==='incomplete'?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(()=>{console.error('Recovery runner failed validation/collection; no completion claimed.');process.exitCode=1;});
