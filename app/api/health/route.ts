import { agentProfiles, type AgentId } from "../../../lib/knowledge";
import { resolveAgentRuntime } from "../../../lib/local-llm";

export const dynamic = "force-dynamic";

export async function GET() {
  const ids = Object.keys(agentProfiles) as AgentId[];
  const agents = await Promise.all(
    ids.map(async (id) => {
      const runtime = resolveAgentRuntime(id);
      try {
        const response = await fetch(`${runtime.baseUrl}/api/version`, {
          cache: "no-store",
          signal: AbortSignal.timeout(2_000),
        });
        return { id, connected: response.ok, model: runtime.model };
      } catch {
        return { id, connected: false, model: runtime.model };
      }
    }),
  );
  const connected = agents.filter((agent) => agent.connected).length;
  return Response.json(
    {
      status: connected === agents.length ? "connected" : connected ? "degraded" : "disconnected",
      connected,
      total: agents.length,
      model: [...new Set(agents.map((agent) => agent.model))].join(", "),
      agents,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
