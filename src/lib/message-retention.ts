export const DELETED_MESSAGE_RETENTION_SECONDS = 24 * 60 * 60;
export const DELETED_MESSAGE_RETENTION_MS =
  DELETED_MESSAGE_RETENTION_SECONDS * 1000;
export type RetainedMessage = {
  deletedAt?: string | Date | null;
  imageExpiresAt?: string | Date | null;
  kind?: string;
  accountPurgeAt?: string | Date | null;
};
export function messageRemovalTime(message: RetainedMessage): number {
  const deadlines: number[] = [];
  for (const value of [message.deletedAt, message.imageExpiresAt]) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time))
      deadlines.push(time + DELETED_MESSAGE_RETENTION_MS);
  }
  if (message.accountPurgeAt) {
    const time = new Date(message.accountPurgeAt).getTime();
    if (Number.isFinite(time)) deadlines.push(time);
  }
  return deadlines.length ? Math.min(...deadlines) : Infinity;
}
export function messageRetentionExpired(
  message: RetainedMessage,
  now = Date.now(),
): boolean {
  return messageRemovalTime(message) <= now;
}
export function retainedMessageFilter(now = Date.now()) {
  const cutoff = new Date(now - DELETED_MESSAGE_RETENTION_MS);
  return {
    $nor: [
      { deletedAt: { $lte: cutoff } },
      { imageExpiresAt: { $lte: cutoff } },
      { accountPurgeAt: { $lte: new Date(now) } },
    ],
  };
}
