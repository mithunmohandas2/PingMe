"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  imageDeadline,
  imageExpired,
  imageTimeLeft,
  type ImageMessageInfo,
} from "@/lib/image-messages";
import {
  messageRemovalTime,
  type RetainedMessage,
} from "@/lib/message-retention";
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    tick();
    timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", tick);
    }
  };
}
const snapshot = () => now,
  zero = () => 0,
  noop = () => () => {};
export function useImageStatus(message: ImageMessageInfo) {
  const deadline = imageDeadline(message);
  const [expiredDeadline, setExpiredDeadline] = useState<number | null>(null);
  const active =
    expiredDeadline !== deadline &&
    message.kind === "image" &&
    !imageExpired(message);
  const clock = useSyncExternalStore(
    active ? subscribe : noop,
    active ? snapshot : zero,
    zero,
  );
  const current = Math.max(clock, Date.now());
  const expired =
    expiredDeadline === deadline || imageExpired(message, current);
  useEffect(() => {
    if (expired) setExpiredDeadline(deadline);
  }, [expired, deadline]);
  return { expired, remaining: imageTimeLeft(deadline, current) };
}
export function useMessageRetentionExpired(message: RetainedMessage) {
  const deadline = messageRemovalTime(message);
  const active = Number.isFinite(deadline) && deadline > Date.now();
  const clock = useSyncExternalStore(
    active ? subscribe : noop,
    active ? snapshot : zero,
    zero,
  );
  return deadline <= Math.max(clock, Date.now());
}
export default function ImageMessageSummary({
  message,
}: {
  message: ImageMessageInfo;
}) {
  const { expired } = useImageStatus(message);
  return expired ? <em>Image auto deleted</em> : <>Image</>;
}
