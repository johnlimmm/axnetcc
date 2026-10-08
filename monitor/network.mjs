import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';

export function parseNetworkTargets(value = '[]') {
  const targets = JSON.parse(value);
  if (!Array.isArray(targets) || targets.length > 16) throw new Error('INVALID_NETWORK_TARGETS');
  const ids = new Set();
  return targets.map(item => {
    if (!item || !/^[A-Za-z0-9_-]{1,100}$/.test(item.nodeId) || ids.has(item.nodeId) ||
      typeof item.host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(item.host) ||
      !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) throw new Error('INVALID_NETWORK_TARGET');
    ids.add(item.nodeId);
    return { nodeId: item.nodeId, host: item.host, port: item.port };
  });
}

export function probeTcp(target, timeoutMs = 2000) {
  return new Promise(resolve => {
    const start = performance.now(), timestamp = Date.now();
    const socket = createConnection({ host: target.host, port: target.port });
    let settled = false;
    const finish = success => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      resolve({ timestamp, success, connectMs: success ? Math.round((performance.now() - start) * 100) / 100 : null });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}

export function createNetworkSampler(targets, { intervalMs = 5000, probe = probeTcp } = {}) {
  const rows = targets.map(target => ({ target, samples: [] }));
  let timer, stopped = false, pending;
  async function tick() {
    pending = Promise.all(rows.map(async row => {
      const sample = await probe(row.target);
      row.samples.push(sample); if (row.samples.length > 120) row.samples.shift();
    }));
    await pending;
    if (!stopped && rows.length) timer = setTimeout(() => { void tick(); }, intervalMs);
  }
  return {
    start() { if (!pending && rows.length) void tick(); },
    snapshot() { return { semantics: 'tcp-connect', vantage: 'monitor-process', intervalMs,
      retention: 'in-memory-last-120-samples', targets: rows.map(row => ({ nodeId: row.target.nodeId, samples: row.samples.map(sample => ({ ...sample })) })) }; },
    async stop() { stopped = true; clearTimeout(timer); await pending; },
  };
}
