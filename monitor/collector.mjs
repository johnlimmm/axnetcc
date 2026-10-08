export function createCollector({ store, serviceUrl, token = "", intervalMs = 5000, fetchImpl = fetch, clock = Date.now, retentionDays = 30 }) {
  let timer, running = false, stopped = false;
  let cachedHealth = null, healthAt = 0;
  const source = new URL(serviceUrl);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password) throw new Error("INVALID_MONITOR_SOURCE");
  async function json(path) {
    const response = await fetchImpl(new URL(path, source), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  }
  async function collect() {
    if (running || stopped) return;
    running = true;
    const at = clock();
    let active = null;
    try {
      let pages = 0;
      while (true) {
        const cursor = store.cursor();
        const packet = await json(`/api/telemetry?after=${cursor.after}&instance=${encodeURIComponent(cursor.instance)}`);
        store.ingest(packet, at);
        active = packet.active;
        if (!packet.hasMore || ++pages >= 20) break;
      }
      if (at - healthAt >= 30_000 || !cachedHealth) {
        try {
          const health = await json("/api/health");
          cachedHealth = {
            observedAt: at,
            // Remote health currently verifies configuration, not network reachability.
            agents: (Array.isArray(health.agents) ? health.agents : []).filter(agent => ["tech", "data", "security", "legal", "policy", "finance", "procurement", "operations"].includes(agent.id)).map(agent => ({ id: agent.id, connected: agent.connected === true, transport: agent.transport === "remote" ? "remote" : "local" })),
            scheduler: { activeCount: health.scheduler?.activeCount ?? null, queueDepth: health.scheduler?.queueDepth ?? null, oldestWaitMs: health.scheduler?.oldestWaitMs ?? null },
          };
          healthAt = at;
        } catch { cachedHealth = null; }
      }
      store.sample({ at, ok: true, active, health: cachedHealth });
      store.prune(at - retentionDays * 86_400_000);
    } catch (error) {
      const code = /^HTTP_\d{3}$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE";
      try { store.sample({ at, ok: false, error: code }); } catch { /* Keep the source service independent of collector disk errors. */ }
    } finally { running = false; }
  }
  async function loop() {
    await collect();
    if (!stopped) timer = setTimeout(loop, intervalMs);
  }
  return { collect, start() { stopped = false; void loop(); }, async stop() { stopped = true; clearTimeout(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); } };
}
