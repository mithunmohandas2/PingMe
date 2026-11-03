import Redis from "ioredis";
let publisher: Redis | undefined;
let publisherReady: Promise<void> | undefined;
async function publishEvent(event: Record<string, unknown>) {
  if (!process.env.REDIS_URL) return;
  try {
    if (!publisher) {
      publisher = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      publisher.on("error", (e) =>
        console.error("Realtime publisher error", e),
      );
      publisherReady = publisher.connect().catch((e) => {
        publisher?.disconnect();
        publisher = undefined;
        publisherReady = undefined;
        throw e;
      });
    }
    await publisherReady;
    await publisher.publish("pingme:events", JSON.stringify(event));
  } catch (e) {
    console.error(
      "Realtime publish failed; clients fall back to synchronization",
      e,
    );
  }
}

export async function publishChatUpdate(chatId: string, recipients: string[]) {
  await publishEvent({ type: "chat:update", chatId, recipients });
}
export async function revokeUserSessions(userId: string) {
  await publishEvent({ type: "session:revoke", userId });
}
