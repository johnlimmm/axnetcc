import { authorizeDemoRequest, validateDemoOptions } from "../../../lib/demo-profile";
import { RunRegistryError, runRegistry } from "../../../lib/run-registry";
import type { RunMode } from "../../../lib/orchestrator";
import { getRequestExecutionContext } from "vinext/shims/request-context";

export const dynamic = "force-dynamic";

function normalizeMode(value: unknown): RunMode {
  return value === "parallel" ||
    value === "centralized" ||
    value === "managed" ||
    value === "masrouter" ||
    value === "remoterag"
    ? value
    : "proposed";
}

export async function POST(request: Request) {
  const acceptedAt = Date.now();
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  let body: { query?: unknown; mode?: unknown; commercialJudge?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const forbidden = validateDemoOptions(body);
  if (forbidden) return forbidden;
  if (typeof body.query !== "string" || body.query.trim().length < 5 || body.query.length > 20_000) {
    return Response.json({ error: "INVALID_QUERY" }, { status: 400 });
  }
  try {
    const executionContext = getRequestExecutionContext();
    const started = await runRegistry.start({
      acceptedAt,
      query: body.query.trim(),
      mode: normalizeMode(body.mode),
      commercialJudge: body.commercialJudge === true,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    }, executionContext ? (execution) => executionContext.waitUntil(execution) : undefined);
    return Response.json(
      {
        requestId: started.requestId,
        status: runRegistry.get(started.requestId)?.status ?? "queued",
        reused: started.reused,
        statusUrl: `/api/runs/${started.requestId}`,
        eventsUrl: `/api/runs/${started.requestId}/events`,
      },
      {
        status: 202,
        headers: {
          location: `/api/runs/${started.requestId}`,
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof RunRegistryError) {
      return Response.json(
        { error: error.code },
        { status: error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400 },
      );
    }
    return Response.json({ error: "RUN_START_FAILED" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  return Response.json(runRegistry.snapshot(), {
    headers: { "cache-control": "no-store" },
  });
}
