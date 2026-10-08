import { authorizeDemoRequest, validateDemoOptions, createDemoDeadline } from "../../../lib/demo-profile";
import { orchestrate, type RunMode } from "../../../lib/orchestrator";

export async function POST(request: Request) {
  const acceptedAt = Date.now();
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  let body: { query?: unknown; mode?: unknown; commercialJudge?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "올바른 JSON 요청이 아닙니다." }, { status: 400 });
  }

  const forbidden = validateDemoOptions(body);
  if (forbidden) return forbidden;
  if (
    typeof body.query !== "string" ||
    body.query.trim().length < 5 ||
    body.query.length > 20_000
  ) {
    return Response.json({ error: "query는 5자 이상 20,000자 이하여야 합니다." }, { status: 400 });
  }
  const mode: RunMode =
    body.mode === "parallel" ||
    body.mode === "centralized" ||
    body.mode === "managed" ||
    body.mode === "masrouter" ||
    body.mode === "remoterag"
      ? body.mode
      : "proposed";

  const deadline = createDemoDeadline(request.signal, acceptedAt);
  try {
    const result = await orchestrate(body.query, mode, body.commercialJudge === true, undefined, deadline.signal);
    deadline.signal.throwIfAborted();
    return Response.json(result);
  } catch (error) {
    if (deadline.expired) return Response.json({ error: "DEMO_RUN_DEADLINE_EXCEEDED" }, { status: 504 });
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return Response.json({ error: "요청 처리가 취소되었습니다." }, { status: 499 });
    }
    return Response.json({ error: "요청 처리 중 오류가 발생했습니다." }, { status: 500 });
  } finally { deadline.dispose(); }
}
