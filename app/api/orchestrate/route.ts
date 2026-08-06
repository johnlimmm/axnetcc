import { orchestrate, type RunMode } from "../../../lib/orchestrator";
import { POST as planEvidenceRequest } from "../evidence/plan/route";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { query?: unknown; mode?: unknown; commercialJudge?: unknown; evidenceStrategy?: unknown; securityEmulation?: unknown; networkScenario?: unknown; requesterZone?: unknown };
    if (typeof body.query !== "string" || body.query.trim().length < 5) {
      return Response.json({ error: "query는 5자 이상이어야 합니다." }, { status: 400 });
    }
    const mode: RunMode =
      body.mode === "parallel" ||
      body.mode === "centralized" ||
      body.mode === "managed" ||
      body.mode === "masrouter" ||
      body.mode === "remoterag"
        ? body.mode
        : "proposed";
    const result = await orchestrate(body.query, mode, body.commercialJudge === true);
    const evidenceStrategy = body.evidenceStrategy === "axnetcc-saea" ? "axnetcc-saea" : "legacy";
    const securityEmulation = body.securityEmulation === true;
    if (evidenceStrategy === "legacy" && !securityEmulation) return Response.json(result);
    const selectedRoles = result.agents.filter((agent) => agent.selected).map((agent) => agent.id);
    const planResponse = await planEvidenceRequest(new Request("http://localhost/api/evidence/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: body.query, selectedRoles, evidenceStrategy, networkScenario: body.networkScenario, requesterZone: body.requesterZone }),
    }));
    return Response.json({ ...result, evidenceStrategy, securityEmulation, evidencePlan: await planResponse.json() });
  } catch {
    return Response.json({ error: "올바른 JSON 요청이 아닙니다." }, { status: 400 });
  }
}
