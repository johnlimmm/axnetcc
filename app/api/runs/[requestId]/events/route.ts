import {
  publicRunEventIsTerminal,
  RunRegistryError,
  runRegistry,
  type PublicRunEvent,
} from "../../../../../lib/run-registry";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ requestId: string }> };

function parseLastEventId(request: Request) {
  const header = request.headers.get("last-event-id");
  const query = new URL(request.url).searchParams.get("after");
  const parsed = Number(header ?? query ?? 0);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(request: Request, context: RouteContext) {
  const { requestId } = await context.params;
  if (!runRegistry.get(requestId)) {
    return Response.json({ error: "RUN_NOT_FOUND" }, { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // A disconnected browser may already have closed the stream.
        }
      };
      const send = (event: PublicRunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(
          `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
        ));
        if (publicRunEventIsTerminal(event)) close();
      };
      try {
        const subscription = runRegistry.subscribe(requestId, parseLastEventId(request), send);
        unsubscribe = subscription.unsubscribe;
        for (const event of subscription.backlog) {
          send(event);
          if (closed) return;
        }
        if (subscription.terminal) {
          close();
          return;
        }
        heartbeat = setInterval(() => {
          if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
        }, 15_000);
      } catch (error) {
        if (!(error instanceof RunRegistryError)) throw error;
        close();
      }
      const abort = () => close();
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
