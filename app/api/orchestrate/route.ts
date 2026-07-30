import { orchestrate, type RunMode } from "../../../lib/orchestrator";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { query?: unknown; mode?: unknown };
    if (typeof body.query !== "string" || body.query.trim().length < 5) {
      return Response.json({ error: "query는 5자 이상이어야 합니다." }, { status: 400 });
    }
    const mode: RunMode =
      body.mode === "parallel" || body.mode === "centralized" || body.mode === "managed" ? body.mode : "proposed";
    return Response.json(await orchestrate(body.query, mode));
  } catch {
    return Response.json({ error: "올바른 JSON 요청이 아닙니다." }, { status: 400 });
  }
}
