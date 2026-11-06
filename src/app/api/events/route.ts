import { requireUser } from "@/lib/auth";
import { fail, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
import { subscribeRealtime } from "@/lib/realtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const userId = await requireUser();
    if (!userId) return fail("Unauthorized", 401);
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined,
      lifetime: ReturnType<typeof setTimeout> | undefined;
    let closed = false,
      live = false;
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      req.signal.removeEventListener("abort", close);
      try {
        controller?.close();
      } catch {
        /* Stream already canceled. */
      }
    };
    const send = (event: object) => {
      if (closed) return;
      if (controller.desiredSize !== null && controller.desiredSize < -128) {
        close();
        return;
      }
      try {
        controller.enqueue(
          encoder.encode("data: " + JSON.stringify(event) + "\n\n"),
        );
      } catch {
        close();
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        req.signal.addEventListener("abort", close, { once: true });
        if (req.signal.aborted) {
          close();
          return;
        }
        unsubscribe = subscribeRealtime(
          userId,
          (event) => {
            if (event.type === "session:revoke") {
              send({ type: event.type });
              close();
            } else send({ type: "chat:update", chatId: event.chatId });
          },
          (ready) => {
            live = ready;
            send({ type: "sync:status", live });
          },
        );
        heartbeat = setInterval(
          () => send({ type: "sync:status", live }),
          20000,
        );
        // Reconnect before bounded-duration hosting stops the stream; reconnect reconciles missed events.
        lifetime = setTimeout(close, 240000);
      },
      cancel() {
        close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "private, no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
