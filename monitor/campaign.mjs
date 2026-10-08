import { readFileSync, statSync } from 'node:fs';
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value) ? value : null;
export function summarizeCampaign(samples) {
  const groups = new Map();
  for (const sample of samples) {
    if (!safe(sample.method) || !safe(sample.scenario)) continue;
    const key = `${sample.method}/${sample.scenario}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const mean = values => { const measured = values.filter(finite); return measured.length ? measured.reduce((a,b) => a+b,0)/measured.length : null; };
  const percentile = (values, p) => { const measured = values.filter(finite).sort((a,b) => a-b); return measured.length ? measured[Math.ceil(measured.length*p)-1] : null; };
  return [...groups.values()].map(rows => ({ method: rows[0].method, scenario: rows[0].scenario, count: rows.length,
    successCount: rows.filter(row => row.status === 'completed' && row.realInference === true).length,
    p50Ms: percentile(rows.map(row => row.elapsedMs),.5), p95Ms: percentile(rows.map(row => row.elapsedMs),.95),
    ...Object.fromEntries(['ttftMs','tpotMs','tokensPerSecond','requestBytes','responseBytes','tcpConnectMs'].map(key => [key,mean(rows.map(row => row[key]))])),
    coverage: Object.fromEntries(['elapsedMs','ttftMs','tpotMs','tokensPerSecond','requestBytes','responseBytes','tcpConnectMs'].map(key => [key,rows.filter(row => finite(row[key])).length])),
  }));
}
export function readCampaign(filename) {
  if (!filename) return { status: 'missing', groups: [], samples: [] };
  try {
    if (statSync(filename).size > 16_000_000) throw new Error('limit');
    const report = JSON.parse(readFileSync(filename,'utf8'));
    if (report.schema !== 'distributed-showcase/v1' || !Array.isArray(report.samples) || report.samples.length > 1000) throw new Error('schema');
    const samples = report.samples.map(row => ({ method: safe(row.method), scenario: safe(row.scenario), status: safe(row.status),
      requestId: safe(row.requestId), realInference: row.realInference === true,
      ...Object.fromEntries(['elapsedMs','ttftMs','tpotMs','tokensPerSecond','requestBytes','responseBytes','tcpConnectMs'].map(key => [key,finite(row[key]) ? row[key] : null])) }));
    return { status:'ready', manifest: { deploymentId: safe(report.manifest?.deploymentId), startedAt: typeof report.manifest?.startedAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(report.manifest.startedAt) ? report.manifest.startedAt : null,
      state:['running','completed','partial'].includes(report.state) ? report.state:'unknown',faultRestored:report.faultRestored===true,
      sampleCount: samples.length, plannedCount: Number.isSafeInteger(report.manifest?.plannedCount) ? report.manifest.plannedCount:null, concurrency: 1,
      networkSemantics: 'TCP connect from HPC; injected delays are application-proxy conditions, not link impairment',
      quality: 'execution availability only; semantic correctness not graded', seed: Number.isSafeInteger(report.manifest?.seed) ? report.manifest.seed:null }, groups: summarizeCampaign(samples), samples };
  } catch { return { status:'invalid', groups:[],samples:[] }; }
}
