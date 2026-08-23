import { agentProfiles, type AgentId } from "../../../lib/agent-registry";
import { executionSchedulerSnapshot } from "../../../lib/execution-scheduler";

export const dynamic = "force-dynamic";

const publicResourceIds = new Map<string, string>();

function publicResourceId(resourceKey: string) {
  const existing = publicResourceIds.get(resourceKey);
  if (existing) return existing;
  const id = `resource-${publicResourceIds.size + 1}`;
  publicResourceIds.set(resourceKey, id);
  return id;
}

export async function GET() {
  const ids = Object.keys(agentProfiles) as AgentId[];
  const edgeMode = (process.env.EDGE_AGENT_MODE ?? "auto").toLowerCase();
  const agents = await Promise.all(
    ids.map(async (id) => {
      const edgeBaseUrl = process.env[`EDGE_AGENT_${id.toUpperCase()}_BASE_URL`] ?? process.env.EDGE_AGENT_BASE_URL ?? "";
      if (edgeMode === "remote" || (edgeMode === "auto" && edgeBaseUrl)) {
        let secureEndpoint = false;
        try {
          const url = new URL(edgeBaseUrl);
          secureEndpoint = url.protocol === "https:" ||
            (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname));
        } catch {
          secureEndpoint = false;
        }
        return {
          id,
          connected: Boolean(edgeBaseUrl && secureEndpoint),
          model: "Edge managed",
          transport: "remote" as const,
        };
      }
      // 개발용 단일 프로세스 모드에서만 Ollama를 직접 점검한다.
      const { resolveAgentRuntime } = await import("../../../lib/local-llm");
      const runtime = resolveAgentRuntime(id);
      if (!runtime.baseUrl) {
        return { id, connected: false, model: runtime.model, transport: "local" as const };
      }
      try {
        const response = await fetch(`${runtime.baseUrl}/api/version`, {
          cache: "no-store",
          signal: AbortSignal.timeout(2_000),
        });
        return { id, connected: response.ok, model: runtime.model, transport: "local" as const };
      } catch {
        return { id, connected: false, model: runtime.model, transport: "local" as const };
      }
    }),
  );
  const connected = agents.filter((agent) => agent.connected).length;
  const queueSnapshots = executionSchedulerSnapshot();
  const schedulerSummary = queueSnapshots.reduce(
    (summary, queue) => ({
      resourceCount: summary.resourceCount + 1,
      activeCount: summary.activeCount + queue.activeCount,
      queueDepth: summary.queueDepth + queue.queueDepth,
      oldestWaitMs: Math.max(summary.oldestWaitMs, queue.oldestWaitMs),
    }),
    { resourceCount: 0, activeCount: 0, queueDepth: 0, oldestWaitMs: 0 },
  );
  const observedAt = Date.now();
  const scheduler = {
    ...schedulerSummary,
    resources: queueSnapshots.map((queue) => ({
      id: publicResourceId(queue.resourceKey),
      capacity: queue.capacity,
      activeCount: queue.activeCount,
      queueDepth: queue.queueDepth,
      oldestWaitMs: queue.oldestWaitMs,
      running: queue.active.map((task) => ({
        taskKind: task.taskKind,
        agentId: task.agentId ?? null,
        stage: task.stage,
        runningForMs: Math.max(0, observedAt - task.dispatchedAt),
      })),
    })),
  };
  return Response.json(
    {
      status: connected === agents.length ? "connected" : connected ? "degraded" : "disconnected",
      connected,
      total: agents.length,
      model: [...new Set(agents.map((agent) => agent.model))].join(", "),
      edgeMode,
      agents,
      scheduler,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
