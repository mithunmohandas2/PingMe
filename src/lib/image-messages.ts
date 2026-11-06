export const IMAGE_LIFETIME_MS = 60 * 60 * 1000;
export type ImageMessageInfo = {
  kind?: string;
  imageExpiresAt?: string | Date | null;
  createdAt?: string | Date;
};
export function imageDeadline(message: ImageMessageInfo): number {
  if (message.kind !== "image") return Infinity;
  const sent = new Date(message.createdAt || "").getTime();
  const expires = new Date(message.imageExpiresAt || "").getTime();
  return Number.isFinite(sent) && Number.isFinite(expires)
    ? Math.min(expires, sent + IMAGE_LIFETIME_MS)
    : 0;
}
export function imageExpired(
  message: ImageMessageInfo,
  now = Date.now(),
): boolean {
  return message.kind === "image" && imageDeadline(message) <= now;
}
export function imageTimeLeft(deadline: number, now: number): string {
  if (!Number.isFinite(deadline)) return "00:00";
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0") +
    ":" +
    (seconds % 60).toString().padStart(2, "0")
  );
}
