import { authorizeDemoRequest, validateDemoOptions, createDemoDeadline } from "../../../../lib/demo-profile";
import { orchestrate, type RunMode } from "../../../../lib/orchestrator";

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
    return Response.json({ error: "요청 본문은 올바른 JSON이어야 합니다." }, { status: 400 });
  }

  const forbidden = validateDemoOptions(body);
  if (forbidden) return forbidden;
  if (typeof body.query !== "string" || body.query.trim().length < 5 || body.query.length > 20_000) {
    return Response.json({ error: "query는 5자 이상 20,000자 이하여야 합니다." }, { status: 400 });
  }

  const mode = normalizeMode(body.mode);
  const encoder = new TextEncoder();
  const deadline = createDemoDeadline(request.signal, acceptedAt);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        } catch {
          cancelled = true;
        }
      };

      void orchestrate(
        body.query as string,
        mode,
        body.commercialJudge === true,
        (event) => send({ type: "progress", event }),
        deadline.signal,
      )
        .then((result) => {
          deadline.signal.throwIfAborted();
          send({ type: "result", result });
        })
        .catch((error) => {
          send({
            type: "error",
            error: deadline.expired ? "DEMO_RUN_DEADLINE_EXCEEDED" : error instanceof Error ? error.message : "오케스트레이션 실행에 실패했습니다.",
          });
        })
        .finally(() => {
          deadline.dispose();
          if (cancelled) return;
          try {
            controller.close();
          } catch {
            cancelled = true;
          }
        });
    },
    cancel() {
      cancelled = true;
      // Observation disconnect is not an explicit cancellation. The absolute budget remains active.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
    },
  });
}
