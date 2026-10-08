import { timingSafeEqual } from "node:crypto";

export function demoProfile() {
  return process.env.DEMO_PROFILE ?? "";
}

/** Enforce before parsing or scheduling; disabled deployments retain their existing API. */
export function authorizeDemoRequest(request: Request): Response | null {
  const profile = demoProfile();
  if (!profile) return null;
  if (profile !== "service" && profile !== "operator") {
    return Response.json({ error: "DEMO_PROFILE_INVALID" }, { status: 503 });
  }
  if (profile !== "operator") return null;
  const expected = process.env.DEMO_OPERATOR_TOKEN ?? "";
  if (!expected) return Response.json({ error: "DEMO_OPERATOR_NOT_CONFIGURED" }, { status: 503 });
  const supplied = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return Response.json({ error: "DEMO_OPERATOR_UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}

export function validateDemoOptions(body: { mode?: unknown; commercialJudge?: unknown }): Response | null {
  const profile = demoProfile();
  if (!profile) return null;
  if ((body.commercialJudge !== undefined && body.commercialJudge !== false) ||
      (profile === "service" && body.mode !== undefined && body.mode !== "proposed")) {
    return Response.json({ error: "DEMO_OPTIONS_FORBIDDEN" }, { status: 403 });
  }
  return null;
}

export function demoRunTimeoutMs(): number | null {
  if (!demoProfile()) return null;
  const configured = Number(process.env.DEMO_RUN_TIMEOUT_MS ?? 120_000);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 120_000 ? configured : 120_000;
}

/** One absolute budget; never reset between queueing, retries and synthesis. */
export function createDemoDeadline(parent?: AbortSignal, acceptedAt = Date.now()) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const duration = demoRunTimeoutMs();
  const deadlineAt = duration === null ? null : acceptedAt + duration;
  let expired = false;
  const timer = deadlineAt === null ? undefined : setTimeout(() => {
    expired = true;
    controller.abort(new DOMException("DEMO_RUN_DEADLINE_EXCEEDED", "TimeoutError"));
  }, Math.max(0, deadlineAt - Date.now()));
  return {
    signal: controller.signal,
    deadlineAt,
    get expired() { return expired; },
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
  };
}
