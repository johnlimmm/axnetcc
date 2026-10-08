import { telemetry } from "../../../lib/telemetry";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = process.env.MONITOR_SCRAPE_TOKEN;
  if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const params = new URL(request.url).searchParams;
  const after = Number(params.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "INVALID_CURSOR" }, { status: 400 });
  return Response.json(telemetry.snapshot(after, params.get("instance") ?? undefined), { headers: { "cache-control": "no-store" } });
}
