import { authorizeDemoRequest } from "../../../../lib/demo-profile";
import { RunRegistryError, runRegistry } from "../../../../lib/run-registry";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ requestId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  const { requestId } = await context.params;
  const snapshot = runRegistry.get(requestId);
  if (!snapshot) return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
  return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(request: Request, context: RouteContext) {
  const denied = authorizeDemoRequest(request);
  if (denied) return denied;
  const { requestId } = await context.params;
  try {
    return Response.json(runRegistry.cancel(requestId), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof RunRegistryError && error.code === "RUN_NOT_FOUND") {
      return Response.json({ error: error.code }, { status: 404 });
    }
    return Response.json({ error: "RUN_CANCEL_FAILED" }, { status: 409 });
  }
}
