import { metricsCsv } from '../lib/metrics-csv.ts';
const terminal = new Set(['completed', 'partial_failed', 'failed', 'cancelled', 'interrupted']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const percentile = (values, p) => { const sorted = values.filter(finite).sort((a,b) => a-b); return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p)-1)] : null; };
const latency = run => finite(run.metrics?.latencyMs) ? run.metrics.latencyMs : finite(run.completedAt) && run.completedAt >= run.startedAt ? run.completedAt-run.startedAt : null;
const measured = value => finite(value) ? value : null;

/** Provider timing and application payloads only; never estimate NIC traffic or RTT. */
export function distributedPerformance(runs) {
  return runs.filter(run => run.distributed).flatMap(run => [
    ...run.distributed.attempts.map(attempt => ({ ...attempt, kind: 'agent', id: attempt.attemptId, at: attempt.startedAt })),
    ...(run.distributed.calls ?? []).map(call => ({ ...call, kind: 'core', id: call.callId, at: call.startedAt,
      elapsedMs: finite(call.startedAt) && finite(call.endedAt) && call.endedAt >= call.startedAt ? call.endedAt-call.startedAt : null })),
  ].map(item => ({
    runId: run.runId, instanceId: run.instanceId, deploymentId: run.distributed.deploymentId,
    kind: item.kind, id: item.id, nodeId: item.nodeId ?? 'unclassified', agentId: item.agentId ?? item.stage,
    at: measured(item.at), status: item.status, backend: item.backend,
    elapsedMs: measured(item.elapsedMs), ttftMs: measured(item.ttftMs), tpotMs: measured(item.tpotMs),
    tokensPerSecond: measured(item.tokensPerSecond), requestBytesPrepared: measured(item.requestBytesPrepared),
    responseBytesReceived: measured(item.responseBytesReceived),
  }))).sort((a,b) => (a.at ?? Infinity)-(b.at ?? Infinity));
}

/** Reconstructed event lanes, timestamped by the central service, not remote stdout. */
export function distributedRunEvents(run) {
  const events = [];
  const add = (at, lane, nodeId, id, message) => {
    if (finite(at)) events.push({ at, lane, nodeId, id, message, source: 'central-observed' });
  };
  add(run.startedAt, 'central', null, run.runId, 'run started');
  for (const attempt of run.distributed?.attempts ?? []) {
    add(attempt.startedAt, 'node', attempt.nodeId, attempt.attemptId, `${attempt.agentId} ${attempt.role} attempt started`);
    add(attempt.completedAt, 'node', attempt.nodeId, attempt.attemptId,
      `${attempt.agentId} ${attempt.status}${attempt.reasonCode ? ` (${attempt.reasonCode})` : ''} · ${attempt.adopted ? 'adopted' : 'not adopted'}`);
  }
  for (const call of run.distributed?.calls ?? []) {
    add(call.startedAt, 'central', call.nodeId, call.callId, `${call.stage} inference started`);
    add(call.endedAt, 'central', call.nodeId, call.callId, `${call.stage} ${call.status ?? 'unknown'}`);
  }
  add(run.completedAt, 'central', null, run.runId, `run ${run.status}`);
  return events.sort((a,b) => a.at-b.at);
}
export function distributedSummary(runs) {
  const observed = runs.filter(run => run.distributed);
  const completed = observed.filter(run => terminal.has(run.status));
  const real = completed.filter(run => {
    const participants = [
      ...run.distributed.attempts.filter(attempt => attempt.adopted && attempt.usageStatus !== 'not-started'),
      ...(run.distributed.calls ?? []),
    ];
    return run.status === 'completed' && participants.length > 0 &&
      participants.every(item => item.backend === 'ollama' && item.status === 'succeeded') &&
      run.distributed.stages.every(stage => stage.backend === 'ollama');
  });
  const attempts = observed.flatMap(run => run.distributed.attempts.map(attempt => ({ ...attempt, runId: run.runId, instanceId: run.instanceId })));
  const nodes = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.nodeId}/${attempt.agentId}`;
    const row = nodes.get(key) ?? { nodeId: attempt.nodeId, agentId: attempt.agentId, attempts: 0, adopted: 0, failures: 0, knownPromptTokens: 0, knownCompletionTokens: 0, unknownAttempts: 0, requestBytesPrepared: 0, responseBytesReceived: 0 };
    row.attempts++; if (attempt.adopted) row.adopted++; if (attempt.status !== 'succeeded') row.failures++;
    row.knownPromptTokens += attempt.promptTokens ?? 0; row.knownCompletionTokens += attempt.completionTokens ?? 0;
    if (attempt.usageStatus !== 'not-started' && (attempt.promptTokens === null || attempt.completionTokens === null)) row.unknownAttempts++;
    row.requestBytesPrepared += attempt.requestBytesPrepared ?? 0; row.responseBytesReceived += attempt.responseBytesReceived ?? 0;
    nodes.set(key,row);
  }
  const totals = observed.map(run => run.distributed.totals);
  const sum = key => totals.reduce((value, item) => value + (item[key] ?? 0), 0);
  const complete = totals.length > 0 && totals.every(item => item.promptTokens !== null && item.completionTokens !== null);
  const distribution = list => ({ count: list.length, timingSamples: list.filter(run => finite(latency(run))).length, p50: percentile(list.map(latency), .5), p95: percentile(list.map(latency), .95) });
  return {
    sourceCounts: Object.fromEntries(['configured-demo','unclassified'].map(source => [source, observed.filter(run => run.distributed.source === source).length])),
    deploymentCounts: Object.fromEntries([...new Set(observed.map(run => run.distributed.deploymentId ?? 'unclassified'))].map(id => [id, observed.filter(run => (run.distributed.deploymentId ?? 'unclassified') === id).length])),
    observedRuns: observed.length, legacyRunsExcluded: runs.length-observed.length,
    allTerminal: distribution(completed), finalizedRealSuccess: distribution(real),
    realSuccessRate: completed.length ? real.length/completed.length : null,
    adoptedBackupAttempts: attempts.filter(item => item.role === 'backup' && item.adopted && item.backend === 'ollama').length,
    // Recovery rate needs fault-target/workload denominator from the benchmark manifest, not inference here.
    totals: { promptTokens: complete ? sum('knownPromptTokens') : null, completionTokens: complete ? sum('knownCompletionTokens') : null,
      knownPromptTokens: sum('knownPromptTokens'), knownCompletionTokens: sum('knownCompletionTokens'), unknownCount: sum('unknownCount'), inferenceCount: sum('inferenceCount'), measuredCount: sum('measuredCount'),
      requestBytesPrepared: totals.every(item => item.requestBytesPrepared !== null) ? sum('requestBytesPrepared') : null,
      responseBytesReceived: totals.every(item => item.responseBytesReceived !== null) ? sum('responseBytesReceived') : null,
      retryKnownPromptTokens: sum('retryKnownPromptTokens'), retryKnownCompletionTokens: sum('retryKnownCompletionTokens') },
    coreBodyBytes: Object.fromEntries(['requestBytesPrepared','responseBytesReceived'].map(key => {
      const readings=observed.map(run=>run.distributed.coreBodyBytes?.[key]);
      return [key,{value:readings.length && readings.every(item=>finite(item?.value)) ? readings.reduce((sum,item)=>sum+item.value,0):null,
        known:readings.reduce((sum,item)=>sum+(item?.known??0),0),unknownRunCount:readings.filter(item=>!finite(item?.value)).length}];
    })),
    nodes: [...nodes.values()],
    performance: distributedPerformance(observed),
    executionLogs: observed.slice(0, 200).map(run => ({ runId: run.runId, instanceId: run.instanceId, events: distributedRunEvents(run) })),
  };
}
export function distributedAttemptsCsv(runs) {
  const keys = ['attemptId','requestId','agentId','nodeId','replicaId','role','status','reasonCode','startedAt','completedAt','elapsedMs','queueWaitMs','requestBytesPrepared','responseBytesReceived','backend','model','promptTokens','completionTokens','usageStatus','adopted','ttftMs','tpotMs','tokensPerSecond'];
  const rows = [['instance_id','run_id','run_status','deployment_id','source',...keys]];
  for (const run of runs) for (const attempt of run.distributed?.attempts ?? []) rows.push([run.instanceId,run.runId,run.status,run.distributed.deploymentId,run.distributed.source,...keys.map(key => typeof attempt[key] === 'boolean' ? String(attempt[key]) : attempt[key])]);
  return metricsCsv(rows);
}

/** Per-call central inference export, separate from physical Agent attempt bytes. */
export function distributedCallsCsv(runs) {
  const keys = ['callId','stage','detail','nodeId','startedAt','endedAt','status','requestBytesPrepared','requestSubmitted','responseBytesReceived','backend','model','promptTokens','completionTokens','ttftMs','tpotMs','tokensPerSecond'];
  const rows = [['instance_id','run_id','run_status','deployment_id',...keys]];
  for (const run of runs) for (const call of run.distributed?.calls ?? []) rows.push([run.instanceId,run.runId,run.status,run.distributed.deploymentId,...keys.map(key => typeof call[key] === 'boolean' ? String(call[key]) : call[key])]);
  return metricsCsv(rows);
}
