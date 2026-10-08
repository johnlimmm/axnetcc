import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cleanupCampaign, installCampaignInterrupts, residualComputeRisk } from './benchmark-distributed-demo.mjs';

const roles = ['tech','data','security','legal','policy','finance','procurement','operations'];
const terminal = new Set(['completed','partial_failed','failed','cancelled']);
export const digest = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fail = message => { throw new Error(message); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const renderingModes = ['model-guided-extractive','source-grounded-generation'];
/** Configuration declarations only: never observed per-call behavior or semantic proof. */
export function renderingConfiguration(value) {
  if (value === undefined || value === null) return {edge:null,core:null};
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['edge','core'].includes(k))) fail('Invalid rendering configuration');
  for (const key of ['edge','core']) if (value[key] != null && !renderingModes.includes(value[key])) fail('Invalid rendering mode');
  return {edge:value.edge ?? null,core:value.core ?? null};
}
export function validateRenderingBinding(manifest, frozen = {}) {
  const expected=renderingConfiguration(manifest.renderingConfiguration), configured=renderingConfiguration(frozen.renderingConfiguration);
  if (JSON.stringify(expected)!==JSON.stringify(configured)) fail('Rendering configuration freeze mismatch');
  if (configured.core!==null && frozen.answerRendering!==undefined && frozen.answerRendering!==configured.core) fail('Final/Core rendering mismatch');
  return configured;
}
export function nearestRank(values, probability = .95) {
  if (!values.length) return null;
  const sorted = values.map(value => typeof value === 'number' && value >= 0 ? value : Infinity).sort((a,b) => a-b);
  return sorted[Math.ceil(probability * sorted.length)-1];
}
const wireNumber = value => value === Infinity ? 'Infinity' : value;
export function validateManifest(manifest) {
  renderingConfiguration(manifest.renderingConfiguration);
  if (manifest.schemaVersion !== 'grounded-completion/v1' || !id(manifest.deploymentId) || !id(manifest.authorId) || !id(manifest.runtimeAuthorId) || manifest.authorId === manifest.runtimeAuthorId) fail('Independent author identity required');
  if (manifest.concurrency !== 3 || manifest.deadlineMs !== 60000 || manifest.watchdogMs !== 70000 || manifest.maximumRequests !== 180 || manifest.maximumWallMs !== 7200000) fail('Fixed campaign limits required');
  if (!Number.isSafeInteger(manifest.seed) || !Number.isFinite(Date.parse(manifest.frozenAt)) || Date.parse(manifest.frozenAt) > Date.now()) fail('Frozen seed/time required');
  if (!hex(manifest.configurationHash) || !hex(manifest.rubricHash) || !hex(manifest.workloadHash) || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) fail('Frozen hashes required');
  if (!manifest.readiness || !['admit-cold','delivered-readiness-barrier'].includes(manifest.readiness.policy) || typeof manifest.readiness.description !== 'string' || !manifest.readiness.description.trim()) fail('Preregister readiness');
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 50 || new Set(manifest.cases.map(c => c.id)).size !== 50) fail('Exactly 50 unique cases required');
  for (const c of manifest.cases) if (!id(c.id) || !roles.includes(c.role) || !['answerable','mixed','unsupported'].includes(c.kind) || typeof c.query !== 'string' || !c.query.trim() || c.query.length > 10000 || !hex(c.rubricHash)) fail('Invalid case');
  for (const role of roles) if (manifest.cases.filter(c => c.kind === 'answerable' && c.role === role).length !== 5) fail('Five answerable cases per role required');
  if (manifest.cases.filter(c => c.kind === 'mixed').length !== 6 || manifest.cases.filter(c => c.kind === 'unsupported').length !== 4) fail('Safety split must be 6 mixed/4 unsupported');
  if (digest(JSON.stringify(manifest.cases)) !== manifest.workloadHash) fail('Workload hash mismatch');
  for (const a of manifest.artifacts) if (!['build','corpus','prompts','models','configuration','rubrics'].includes(a.kind) || typeof a.path !== 'string' || !hex(a.sha256)) fail('Invalid artifact');
  for (const kind of ['build','corpus','prompts','models','configuration','rubrics']) if (!manifest.artifacts.some(a => a.kind === kind)) fail('Missing frozen artifact kind');
  if (!manifest.artifacts.some(a => a.kind === 'rubrics' && a.sha256 === manifest.rubricHash)) fail('Rubric hash not bound');
  return manifest;
}
export function validateConfig(config) {
  const modes=renderingConfiguration(config.frozenConfiguration?.renderingConfiguration);
  if (modes.core!==null && config.frozenConfiguration?.answerRendering!==undefined && config.frozenConfiguration.answerRendering!==modes.core) fail('Final/Core rendering mismatch');
  for (const key of ['coreUrl','gatewayControlUrl','inferenceControlUrl']) {
    const url = new URL(config[key]);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) fail('Unsafe endpoint');
  }
  for (const key of ['operatorToken','gatewayControlToken','inferenceControlToken']) if (typeof config[key] !== 'string' || config[key].length < 16 || /[\r\n]/.test(config[key])) fail('Private token required');
  return config;
}
export function validateGrades(grades, manifest, samplesHash) {
  if (!grades || grades.schemaVersion !== 'grounded-grades/v1' || grades.reviewType !== 'AI-assisted' || grades.workloadHash !== manifest.workloadHash || grades.samplesHash !== samplesHash || grades.rubricHash !== manifest.rubricHash) fail('Grade binding mismatch');
  if (!id(grades.graderId) || !id(grades.adjudicatorId) || grades.graderId === grades.adjudicatorId || [grades.graderId,grades.adjudicatorId].includes(manifest.runtimeAuthorId)) fail('Independent grading identities required');
  if (!Array.isArray(grades.cases) || grades.cases.length !== 50 || new Set(grades.cases.map(c => c.id)).size !== 50) fail('Grades must cover exactly 50 cases');
  const proposedPasses = [];
  for (const grade of grades.cases) {
    const c = manifest.cases.find(c => c.id === grade.id);
    if (!c || grade.rubricHash !== c.rubricHash || !['F','C','U','safe','visibleClaimsSafe'].every(key => typeof grade[key] === 'boolean') || typeof grade.reason !== 'string' || !grade.reason.trim() || !Array.isArray(grade.claims) || !grade.claims.length) fail('Incomplete semantic grade');
    for (const claim of grade.claims) if (typeof claim.text !== 'string' || !claim.text || !['supported','contradicted','unknown','no-answer'].includes(claim.support) || !Array.isArray(claim.sourceSpans) || (claim.support === 'supported' && !claim.sourceSpans.length)) fail('Claim/source audit missing');
    const passed = grade.visibleClaimsSafe && (c.kind === 'answerable' ? grade.F && grade.C && grade.U : grade.safe && (c.kind !== 'mixed' || grade.F && grade.C && grade.U));
    if (passed) proposedPasses.push(grade); else if (!grade.adjudicated) fail('All proposed failures require adjudication');
  }
  const audit = proposedPasses.sort((a,b) => digest(`${manifest.seed}:${a.id}`).localeCompare(digest(`${manifest.seed}:${b.id}`))).slice(0, Math.ceil(proposedPasses.length * .2));
  if (audit.some(g => g.adjudicated !== true) || (grades.auditMissedUnsupportedClaim === true && proposedPasses.some(g => g.adjudicated !== true))) fail('Independent pass audit incomplete');
  if (grades.evaluationInferenceCount !== undefined && (!Number.isSafeInteger(grades.evaluationInferenceCount) || grades.evaluationInferenceCount < 0)) fail('Invalid evaluation usage');
  if (typeof grades.auditMissedUnsupportedClaim !== 'boolean') fail('Audit outcome required');
  for (const g of grades.cases.filter(g => g.adjudicated)) if (typeof g.adjudicationReason !== 'string' || !g.adjudicationReason.trim() || g.disagreementResolved !== true) fail('Unresolved adjudication');
  return grades;
}
export function summarizeCompletion(manifest, samples, grades = null) {
  const rows = manifest.cases.map(c => ({ c, sample: samples.find(s => s.caseId === c.id && s.occurrence === 1) }));
  const validFinal = s => s && s.status === 'completed' && s.hasFinal === true && s.elapsedMs <= 60000 && s.transcriptComplete === true;
  const q1 = rows.filter(r => r.c.kind === 'answerable'), safety = rows.filter(r => r.c.kind !== 'answerable');
  const complete = rows.every(r => r.sample) && samples.length === 50 && new Set(samples.map(s => s.caseId)).size === 50;
  const allTerminalP95 = nearestRank(q1.map(({ sample:s }) => s && terminal.has(s.status) ? s.elapsedMs : Infinity));
  const finalP95 = nearestRank(q1.map(({ sample:s }) => validFinal(s) ? s.elapsedMs : Infinity));
  const passed = row => {
    const g = grades?.cases.find(g => g.id === row.c.id);
    return Boolean(validFinal(row.sample) && g && g.visibleClaimsSafe && (row.c.kind === 'answerable' ? g.F && g.C && g.U : g.safe && (row.c.kind !== 'mixed' || g.F && g.C && g.U)));
  };
  const answerablePassed = q1.filter(passed).length, safetyPassed = rows.filter(r => r.c.kind !== 'answerable' && passed(r)).length;
  const q3 = grades !== null && rows.every(row => grades.cases.find(g => g.id === row.c.id)?.visibleClaimsSafe);
  const clean = samples.every(s => s.computeCompletionProven === true && s.transcriptComplete === true);
  return { renderingConfiguration:renderingConfiguration(manifest.renderingConfiguration), renderingProvenance:'frozen-configuration-not-per-call-observation', planned:50, admitted:samples.length, primaryDenominator:40, safetyDenominator:10, complete, answerablePassed, safetyPassed,
    safetyLatency:{ denominator:10, allTerminalP95Ms:wireNumber(nearestRank(safety.map(({sample:s}) => s && terminal.has(s.status) ? s.elapsedMs : Infinity))), finalResponseP95Ms:wireNumber(nearestRank(safety.map(({sample:s}) => validFinal(s) ? s.elapsedMs : Infinity))) },
    outcomes:{ completed:samples.filter(s => s.status === 'completed').length, useful:rows.filter(passed).length, realInference:samples.filter(s => s.realInference === true).length, extractive:samples.filter(s => s.answerRendering === 'model-guided-extractive').length, generated:samples.filter(s => s.answerRendering === 'source-grounded-generation').length, renderingUnknown:samples.filter(s => !['model-guided-extractive','source-grounded-generation'].includes(s.answerRendering)).length },
    roleScores:Object.fromEntries(roles.map(role => [role,{ passed:q1.filter(r => r.c.role === role && passed(r)).length, denominator:5 }])),
    allTerminalP95Ms:wireNumber(allTerminalP95), finalResponseP95Ms:wireNumber(finalP95), semanticReview:grades ? 'AI-assisted' : 'pending',
    gates:{ Q1:answerablePassed >= 36, Q2:safetyPassed === 10, Q3:q3, P1:allTerminalP95 <= 60000 && finalP95 <= 60000 },
    qualityLatencyPassed:complete && clean && answerablePassed >= 36 && safetyPassed === 10 && q3 && allTerminalP95 <= 60000 && finalP95 <= 60000,
    fullCompletionProven:false, remainingEvidence:['distributed fault/process-stop/cancellation/cold diagnostics','browser and final independent review'],
    inferenceCounts:{ agent:samples.reduce((n,s) => n+(s.distributed?.attempts ?? []).filter(a => a.backend === 'ollama').length,0), core:samples.reduce((n,s) => n+(s.distributed?.calls ?? []).filter(c => c.backend === 'ollama' && ['synthesis','supervisor'].includes(c.stage)).length,0), onlineVerification:samples.reduce((n,s) => n+(s.distributed?.calls ?? []).filter(c => ['repair','verification'].includes(c.stage)).length,0), evaluation:grades?.evaluationInferenceCount ?? null } };
}
/** One shared latch; it never auto-resumes after transport abort or backup success. */
export async function runConcurrent(cases, execute, { now = () => performance.now(), wallMs = 7200000, onSample = () => {}, signal } = {}) {
  const started = now(), samples = []; let next = 0, reason = null;
  const stop = why => { reason ??= why; };
  const worker = async () => {
    while (!reason) {
      if (signal?.aborted) { stop('interrupted'); break; }
      if (now()-started >= wallMs) { stop('campaign-budget'); break; }
      if (next >= cases.length || next >= 180) break;
      const c = cases[next++];
      let sample;
      try { sample = await execute(c, stop); }
      catch { stop('unhandled-sample-failure'); sample = { caseId:c.id, occurrence:1, status:'unknown', computeCompletionProven:false, elapsedMs:now()-started }; }
      samples.push(sample); onSample(sample);
      if (sample.computeCompletionProven !== true) stop('residual-compute-unproven');
    }
  };
  await Promise.all(Array.from({ length:3 }, worker));
  return { samples, stopReason:reason, admitted:next };
}
function endpoint(config, path) { return new URL(path, config.coreUrl); }
async function request(config, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(endpoint(config,path), { ...options, redirect:'error', headers:{ authorization:`Bearer ${config.operatorToken}`, 'content-type':'application/json', ...options.headers }, signal: options.signal ?? AbortSignal.timeout(10000) });
  if (!response.ok) fail(`http-${response.status}`);
  return response;
}
async function telemetry(config, requestId) {
  let cursor = 0, instance;
  for (let page = 0; page < 100; page++) {
    const data = await (await request(config, `/api/telemetry?after=${cursor}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}`, { headers:{ authorization:`Bearer ${config.telemetryToken ?? config.operatorToken}` } })).json();
    const run = data.runs?.find(r => r.runId === requestId);
    if (run) return run.distributed;
    if (!data.hasMore) break;
    cursor = data.nextCursor; instance = data.instanceId;
  }
  return null;
}
/** Refresh after independent cancellation/drain cleanup, never alter client clocks or drafts.
 * Final transport settlement is not proof of backend compute termination. Prior uncertainty
 * cannot be upgraded by this accounting-only observation.
 */
export async function finalizeAccounting(config, samples, {
  readLedger = requestId => telemetry(config,requestId),
  readSnapshot = async requestId => (await request(config,`/api/runs/${requestId}`)).json(),
} = {}) {
  return Promise.all(samples.map(async sample => {
    let ledger = null, snapshot = null;
    if (sample.requestId) {
      try { snapshot = await readSnapshot(sample.requestId); } catch { /* Independent timeout: retain unknown. */ }
      try { ledger = await readLedger(sample.requestId); } catch { /* Never erase initial known costs. */ }
    }
    const initial = sample.distributed ?? null;
    const recordsRetained = ledger && ledger.totals && ['attempts','calls'].every(key => Array.isArray(ledger[key]) && (initial?.[key] ?? []).every(old => {
      const field = key === 'attempts' ? 'attemptId' : 'callId';
      return old[field] && (ledger[key] ?? []).some(record => record[field] === old[field]);
    }));
    const ledgerObserved = Boolean(recordsRetained);
    const transportSettled = snapshot?.executionSettled === true && terminal.has(snapshot?.status);
    const distributed = structuredClone(ledgerObserved ? ledger : initial);
    const computeCompletionProven = sample.computeCompletionProven === true && ledgerObserved && transportSettled &&
      !residualComputeRisk({ scenario:'healthy-backup-enabled', cancellationRequested:Boolean(sample.reason), distributed });
    if (distributed && (!ledgerObserved || !transportSettled)) {
      distributed.totals = { ...distributed.totals, promptTokens:null, completionTokens:null };
    }
    return { ...sample, distributed, computeCompletionProven,
      initialAccounting:{ distributed:structuredClone(initial), computeCompletionProven:sample.computeCompletionProven },
      accountingFinalization:{ observedAt:new Date().toISOString(), ledgerObserved, transportSettled,
        status:ledgerObserved && transportSettled ? 'final-ledger-observed' : 'unproved',
        backendComputeCompletionUpgraded:false } };
  }));
}
async function collectTranscript(config, requestId, signal) {
  const response = await request(config, `/api/runs/${requestId}/events`, { signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0; const events = [];
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength; if (bytes > 4_000_000) fail('transcript-limit');
      buffer += decoder.decode(item.value, { stream:true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0,boundary); buffer = buffer.slice(boundary+2);
        const data = block.split('\n').find(line => line.startsWith('data: '));
        if (data) events.push({ id:Number(block.match(/^id: (\d+)/m)?.[1]), type:block.match(/^event: (.+)$/m)?.[1], data:JSON.parse(data.slice(6)) });
      }
    }
    return { events, complete:events.length > 0 && ['completed','failed','cancelled'].includes(events.at(-1).type) && events.every((e,i) => e.id === i+1) };
  } catch { return { events, complete:false }; }
  finally { await reader.cancel().catch(() => {}); }
}
export async function executeCase(config, c, stop, active, campaignSignal) {
  const declaredRendering=renderingConfiguration(config.frozenConfiguration?.renderingConfiguration);
  if (declaredRendering.core!==null && config.frozenConfiguration?.answerRendering!==declaredRendering.core) fail('Final/Core rendering mismatch');
  const start = performance.now(), watchdog = AbortSignal.timeout(70000), deadline = AbortSignal.timeout(60000);
  const signal = AbortSignal.any([deadline,watchdog,campaignSignal]);
  let requestId = null, snapshot = null, transcript = { events:[],complete:false }, distributed = null, elapsedMs = null, reason = null;
  // The stop fires at the deadline, not after cleanup/telemetry collection.
  const onAbort = () => stop('deadline-or-interruption'); signal.addEventListener('abort',onAbort,{ once:true });
  try {
    const started = await (await request(config,'/api/runs',{ method:'POST', body:JSON.stringify({ query:c.query, mode:'proposed', commercialJudge:false }), headers:{ 'idempotency-key':`completion-${randomUUID()}` }, signal })).json();
    if (!/^RUN-[a-zA-Z0-9-]+$/.test(started.requestId)) fail('invalid-run-id');
    requestId = started.requestId; active.set(requestId,{ coreUrl:config.coreUrl, token:config.operatorToken, requestId });
    const transcriptPromise = collectTranscript(config,requestId,signal).then(value => value, () => ({ events:[],complete:false }));
    try {
      while (!signal.aborted) {
        snapshot = await (await request(config,`/api/runs/${requestId}`,{ signal })).json();
        if (terminal.has(snapshot.status)) {
          elapsedMs = performance.now()-start;
          if (snapshot.executionSettled) break;
        }
        await sleep(100);
      }
    } finally { transcript = await transcriptPromise; }
    if (!transcript.complete) { reason = 'transcript-incomplete'; stop(reason); }
    elapsedMs = Math.max(elapsedMs ?? 0,performance.now()-start);
    signal.removeEventListener('abort',onAbort);
    distributed = await telemetry(config,requestId);
  } catch { reason ??= 'transport-deadline-or-protocol-failure'; stop(reason); }
  finally { signal.removeEventListener('abort',onAbort); }
  const risk = residualComputeRisk({ scenario:'healthy-backup-enabled', cancellationRequested:Boolean(reason), distributed });
  const computeCompletionProven = !risk && snapshot?.executionSettled === true && terminal.has(snapshot?.status);
  if (computeCompletionProven) active.delete(requestId); else stop('residual-compute-unproven');
  return { caseId:c.id, occurrence:1, requestId, status:snapshot?.status ?? 'unknown', elapsedMs:elapsedMs ?? performance.now()-start,
    hasFinal:snapshot?.status === 'completed' && Boolean(snapshot.result), transcriptComplete:transcript.complete, computeCompletionProven, reason,
    realInference:Boolean(distributed?.attempts?.some(a => a.adopted && a.backend === 'ollama' && a.status === 'succeeded' && Number.isSafeInteger(a.promptTokens) && a.promptTokens >= 0 && Number.isSafeInteger(a.completionTokens) && a.completionTokens >= 0)),
    answerRendering:['model-guided-extractive','source-grounded-generation'].includes(config.frozenConfiguration?.answerRendering) ? config.frozenConfiguration.answerRendering : null,
    renderingConfiguration:renderingConfiguration(config.frozenConfiguration?.renderingConfiguration),
    renderingProvenance:'frozen-configuration-not-semantic-classification',
    distributed, result:snapshot?.result ?? null, transcript:transcript.events };
}
export async function campaign(manifestPath, configPath, directory) {
  const manifest = validateManifest(json(manifestPath)), config = validateConfig(json(configPath));
  validateRenderingBinding(manifest,config.frozenConfiguration);
  if (digest(JSON.stringify(config.frozenConfiguration)) !== manifest.configurationHash) fail('Private configuration freeze mismatch');
  for (const a of manifest.artifacts) if (digest(readFileSync(resolve(dirname(manifestPath),a.path))) !== a.sha256) fail('Frozen artifact mismatch');
  mkdirSync(directory); // Never overwrite or merge a prior trial.
  writeFileSync(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2));
  const startedAt = new Date().toISOString();
  const active = new Map(), controller = new AbortController(); let interruption = null;
  const removeHandlers = installCampaignInterrupts(controller,name => { interruption = name; });
  const timer = setTimeout(() => controller.abort(),7200000); timer.unref();
  const samples = []; let stopReason = null; const cleanup = [];
  // Remove credential values even if a server unexpectedly reflects one into an error/draft.
  const secrets = Object.entries(config).filter(([key,value]) => /token|password|secret/i.test(key) && typeof value === 'string').map(([,value]) => value);
  const sanitize = value => JSON.parse(secrets.reduce((text,secret) => text.split(secret).join('[REDACTED]'),JSON.stringify(value)));
  const sampleFile = resolve(directory,'samples.jsonl'); writeFileSync(sampleFile,'');
  try {
    for (const kind of ['answerable','safety']) {
      const cases = manifest.cases.filter(c => kind === 'answerable' ? c.kind === kind : c.kind !== 'answerable').sort((a,b) => digest(`${manifest.seed}:${a.id}`).localeCompare(digest(`${manifest.seed}:${b.id}`)));
      const result = await runConcurrent(cases,(c,stop) => executeCase(config,c,why => { stop(why); controller.abort(); },active,controller.signal),{ signal:controller.signal,onSample:sample => { const safe = sanitize(sample); samples.push(safe); appendFileSync(sampleFile,JSON.stringify(safe)+'\n'); } });
      if (result.stopReason) { stopReason = result.stopReason; break; }
    }
  } finally {
    cleanup.push(...await Promise.all([...active.values()].map(run => cleanupCampaign(config,run))));
    cleanup.push(await cleanupCampaign(config,null));
    clearTimeout(timer); removeHandlers();
  }
  const finalized = sanitize(await finalizeAccounting(config,samples));
  const finalSampleFile = resolve(directory,'samples-final.jsonl');
  writeFileSync(finalSampleFile,finalized.map(sample => JSON.stringify(sample)+'\n').join(''));
  const report = { schemaVersion:'grounded-completion-report/v1', manifestFile:'manifest.json', manifestHash:digest(readFileSync(resolve(directory,'manifest.json'))), samplesFile:'samples-final.jsonl', samplesHash:digest(readFileSync(finalSampleFile)), initialSamplesFile:'samples.jsonl', initialSamplesHash:digest(readFileSync(sampleFile)), startedWithFrozenConfiguration:manifest.configurationHash,
    startedAt, completedAt:new Date().toISOString(), stopReason, interruption, cleanup, status:stopReason || interruption ? 'incomplete' : 'pending-independent-grades', summary:summarizeCompletion(manifest,finalized) };
  writeFileSync(resolve(directory,'report.json'),JSON.stringify(report,null,2));
  return report;
}
export function verifyReport(reportPath, gradesPath) {
  const report = json(reportPath), root = dirname(reportPath);
  if (report.schemaVersion !== 'grounded-completion-report/v1' || report.manifestFile !== 'manifest.json' || !['samples.jsonl','samples-final.jsonl'].includes(report.samplesFile)) fail('Invalid report layout');
  const manifestBytes = readFileSync(resolve(root,report.manifestFile)), sampleBytes = readFileSync(resolve(root,report.samplesFile));
  if (digest(manifestBytes) !== report.manifestHash || digest(sampleBytes) !== report.samplesHash) fail('Report artifact tampering');
  const manifest = validateManifest(JSON.parse(manifestBytes)), samples = sampleBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (report.samplesFile === 'samples-final.jsonl') {
    if (report.initialSamplesFile !== 'samples.jsonl') fail('Missing initial observations');
    const initialBytes = readFileSync(resolve(root,report.initialSamplesFile));
    if (digest(initialBytes) !== report.initialSamplesHash) fail('Initial observation tampering');
    const initial = initialBytes.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    if (initial.length !== samples.length || initial.some((old,index) => Object.keys(old).filter(key => !['distributed','computeCompletionProven'].includes(key)).some(key => JSON.stringify(old[key]) !== JSON.stringify(samples[index]?.[key])) ||
      JSON.stringify(samples[index]?.initialAccounting) !== JSON.stringify({distributed:old.distributed ?? null,computeCompletionProven:old.computeCompletionProven}) ||
      (old.computeCompletionProven !== true && samples[index]?.computeCompletionProven === true))) fail('Finalization changed client observations');
  }
  if (samples.some(s => !manifest.cases.some(c => c.id === s.caseId) || s.occurrence !== 1 || typeof s.elapsedMs !== 'number' || !Number.isFinite(s.elapsedMs) || s.elapsedMs < 0)) fail('Invalid sample identity/timing');
  const expectedRendering=renderingConfiguration(manifest.renderingConfiguration);
  for (const sample of samples) {
    const actual=renderingConfiguration(sample.renderingConfiguration);
    if (JSON.stringify(actual)!==JSON.stringify(expectedRendering)) fail('Sample rendering configuration mismatch');
    if (actual.core!==null && sample.answerRendering!==actual.core) fail('Sample final/Core rendering mismatch');
  }
  const grades = gradesPath ? validateGrades(json(gradesPath),manifest,report.samplesHash) : null;
  const summary = summarizeCompletion(manifest,samples,grades);
  const shutdown = Array.isArray(report.cleanup) && report.cleanup.length > 0 && report.cleanup.every(c => c.faultsRestored && c.cancellationConfirmed && c.transportDrained);
  return { ...summary, reportValid:!report.stopReason && !report.interruption && shutdown, passed:summary.qualityLatencyPassed && !report.stopReason && !report.interruption && shutdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let i=0;i<args.length;i+=2) { if (!['--manifest','--config','--output','--verify-report','--grades'].includes(args[i]) || !args[i+1] || options[args[i]]) fail('Invalid CLI arguments'); options[args[i]]=args[i+1]; }
    if (options['--verify-report']) {
      if (options['--manifest'] || options['--config'] || options['--output']) fail('Mutually exclusive modes');
      const result = verifyReport(resolve(options['--verify-report']),options['--grades'] && resolve(options['--grades'])); console.log(JSON.stringify(result,null,2)); if (!result.passed) process.exitCode=1;
    } else {
      if (!options['--manifest'] || !options['--config'] || !options['--output'] || options['--grades']) fail('Manifest/config/output required');
      if (!isAbsolute(options['--config'])) fail('Private config must be an absolute path');
      const report = await campaign(resolve(options['--manifest']),resolve(options['--config']),resolve(options['--output'])); console.log(JSON.stringify({ status:report.status, summary:report.summary },null,2)); process.exitCode=1; // Unreviewed measurement is never acceptance.
    }
  } catch { console.error('Completion evaluation failed validation or collection; no acceptance claimed.'); process.exitCode=1; }
}
