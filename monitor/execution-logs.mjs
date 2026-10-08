import { readFileSync, statSync } from 'node:fs';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
const events = new Set(['edge-received','edge-completed','edge-failed','core-attempt-completed','core-inference-completed']);
export function readExecutionLogs(filename) {
  if (!filename) return { status:'missing',updatedAt:null,events:[] };
  try {
    if (statSync(filename).size > 4_000_000) throw new Error('limit');
    const raw=JSON.parse(readFileSync(filename,'utf8'));
    if (!Array.isArray(raw.events) || raw.events.length > 5000) throw new Error('schema');
    return { status:'ready',updatedAt:Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : null,events:raw.events.filter(row => row?.schema==='execution-log/v1' && events.has(row.event)).map(row => ({
      schema:'execution-log/v1', host:id(row.host),event:row.event,requestId:id(row.requestId),agentId:id(row.agentId),attemptId:id(row.attemptId),nodeId:id(row.nodeId),replicaId:id(row.replicaId),status:id(row.status),
      timestamp:typeof row.timestamp==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.timestamp) ? row.timestamp : null,
      elapsedMs:typeof row.elapsedMs==='number' && Number.isFinite(row.elapsedMs) && row.elapsedMs>=0 ? row.elapsedMs:null,
    })) };
  } catch { return { status:'invalid',updatedAt:null,events:[] }; }
}
