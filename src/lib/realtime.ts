import Redis from "ioredis";
import { randomUUID } from "node:crypto";
export function getRedisUrl(): string | undefined {
  return process.env.PING_ME_REDIS_URL?.trim() || undefined;
}
export type RealtimeEvent =
  | {
      type: "chat:update";
      chatId: string;
      recipients: string[];
      eventId: string;
    }
  | { type: "session:revoke"; userId: string; eventId: string };
type Listener = {
  userId: string;
  event: (event: RealtimeEvent) => void;
  status: (live: boolean) => void;
};
type Hub = {
  listeners: Set<Listener>;
  seen: Set<string>;
  subscriber?: Redis;
  publisher?: Redis;
  publisherReady?: Promise<void>;
  subscribed: boolean;
};
const globalHub = globalThis as typeof globalThis & {
  _pingmeRealtimeHub?: Hub;
};
function hub(): Hub {
  return (globalHub._pingmeRealtimeHub ??= {
    listeners: new Set(),
    seen: new Set(),
    subscribed: false,
  });
}
function live(state: Hub) {
  return (
    !getRedisUrl() || (state.subscribed && state.subscriber?.status === "ready")
  );
}
function status(state: Hub) {
  for (const listener of state.listeners) listener.status(live(state));
}
function deliver(state: Hub, event: RealtimeEvent) {
  if (state.seen.has(event.eventId)) return;
  state.seen.add(event.eventId);
  if (state.seen.size > 2000)
    state.seen.delete(state.seen.values().next().value!);
  for (const listener of state.listeners) {
    if (
      (event.type === "chat:update" &&
        event.recipients.includes(listener.userId)) ||
      (event.type === "session:revoke" && event.userId === listener.userId)
    )
      listener.event(event);
  }
}
function connectSubscriber(state: Hub) {
  if (!getRedisUrl() || state.subscriber) return;
  const subscriber = (state.subscriber = new Redis(getRedisUrl()!, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  }));
  subscriber.on("ready", () => {
    void subscriber
      .subscribe("pingme:events")
      .then(() => {
        state.subscribed = true;
        status(state);
      })
      .catch(() => {
        state.subscribed = false;
        status(state);
      });
  });
  subscriber.on("close", () => {
    state.subscribed = false;
    status(state);
  });
  subscriber.on("error", () => {
    state.subscribed = false;
    status(state);
  });
  subscriber.on("message", (_channel, payload) => {
    try {
      const event = JSON.parse(payload);
      if (typeof event.eventId !== "string") return;
      if (
        (event.type === "chat:update" &&
          typeof event.chatId === "string" &&
          Array.isArray(event.recipients)) ||
        (event.type === "session:revoke" && typeof event.userId === "string")
      )
        deliver(state, event);
    } catch {
      /* Ignore invalid broker messages. */
    }
  });
  void subscriber.connect().catch(() => {
    state.subscribed = false;
    status(state);
  });
}
export function subscribeRealtime(
  userId: string,
  event: Listener["event"],
  onStatus: Listener["status"],
) {
  const state = hub(),
    listener = { userId, event, status: onStatus };
  state.listeners.add(listener);
  connectSubscriber(state);
  onStatus(live(state));
  return () => {
    state.listeners.delete(listener);
  };
}
async function publishEvent(event: RealtimeEvent) {
  const state = hub();
  // Same-process delivery works without Redis, including across Next dev route bundles.
  deliver(state, event);
  if (!getRedisUrl()) return;
  try {
    if (!state.publisher) {
      const publisher = (state.publisher = new Redis(getRedisUrl()!, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      }));
      publisher.on("error", () => {});
      state.publisherReady = publisher.connect().catch((error) => {
        publisher.disconnect();
        state.publisher = undefined;
        state.publisherReady = undefined;
        throw error;
      });
    }
    await state.publisherReady;
    await state.publisher!.publish("pingme:events", JSON.stringify(event));
  } catch {
    console.error(
      "Realtime broker unavailable; connected clients use synchronization fallback",
    );
  }
}
export async function publishChatUpdate(chatId: string, recipients: string[]) {
  await publishEvent({
    type: "chat:update",
    chatId,
    recipients,
    eventId: randomUUID(),
  });
}
export async function revokeUserSessions(userId: string) {
  await publishEvent({ type: "session:revoke", userId, eventId: randomUUID() });
}
