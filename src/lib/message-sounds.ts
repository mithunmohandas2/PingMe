type SoundMessage = {
  _id: string;
  createdAt: string;
  sender?: { _id: string } | null;
};
type SoundChat = { _id: string; latestMessage?: SoundMessage | null };
type Marker = { id: string; time: number };
const after = (next: Marker, previous: Marker) =>
  next.time > previous.time ||
  (next.time === previous.time && next.id > previous.id);

// Track chat summaries, rather than message history, so opening a conversation
// is silent and incoming messages in other conversations still notify.
export function createMessageSoundTracker(userId: string) {
  let initialized = false;
  let baseline: Marker | undefined;
  const latest = new Map<string, Marker | null>();
  const seen = new Set<string>();
  function marker(message: SoundMessage): Marker | null {
    const time = Date.parse(message.createdAt);
    return message._id && Number.isFinite(time)
      ? { id: message._id, time }
      : null;
  }
  function remember(chatId: string, value: Marker) {
    const previous = latest.get(chatId);
    if (!previous || after(value, previous)) latest.set(chatId, value);
    seen.add(value.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    if (latest.size > 500) latest.delete(latest.keys().next().value!);
  }
  return {
    observe(chats: readonly SoundChat[]) {
      let notify = false;
      for (const chat of chats) {
        const message = chat.latestMessage;
        if (!message) {
          if (!latest.has(chat._id)) latest.set(chat._id, null);
          continue;
        }
        const value = marker(message);
        if (!value) continue;
        if (!initialized) {
          if (!baseline || after(value, baseline)) baseline = value;
          remember(chat._id, value);
          continue;
        }
        const known = latest.has(chat._id),
          previous = latest.get(chat._id);
        const fresh = previous
          ? after(value, previous)
          : known || !baseline || after(value, baseline);
        if (
          fresh &&
          !seen.has(value.id) &&
          message.sender?._id &&
          message.sender._id !== userId
        )
          notify = true;
        remember(chat._id, value);
      }
      initialized = true;
      return notify;
    },
    sent(chatId: string, message: SoundMessage) {
      const value = marker(message);
      if (value) remember(chatId, value);
    },
  };
}

export function createMessageSoundPlayer(options?: {
  makeAudio?: (source: string) => HTMLAudioElement;
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
}) {
  const makeAudio = options?.makeAudio ?? ((source) => new Audio(source));
  const target = options?.target ?? window;
  const tracks = ["/audio/alert.mp3", "/audio/sentmessage.mp3"].map(
    (source) => {
      const audio = makeAudio(source);
      audio.preload = "auto";
      audio.volume = 0.6;
      return {
        audio,
        ready: false,
        priming: undefined as Promise<void> | undefined,
      };
    },
  );
  let disposed = false;
  const removeListeners = () => {
    target.removeEventListener("pointerdown", unlock, true);
    target.removeEventListener("keydown", unlock, true);
  };
  function unlock() {
    if (disposed) return;
    for (const track of tracks) {
      if (track.ready || track.priming) continue;
      // Start each reusable element in a user gesture, silently, for mobile browsers.
      track.audio.muted = true;
      try {
        track.priming = Promise.resolve(track.audio.play())
          .then(() => {
            track.audio.pause();
            track.audio.currentTime = 0;
            track.ready = true;
          })
          .catch(() => {})
          .finally(() => {
            track.audio.muted = false;
            track.priming = undefined;
            if (tracks.every((item) => item.ready)) removeListeners();
          });
      } catch {
        track.audio.muted = false;
      }
    }
  }
  function play(index: number) {
    if (disposed) return;
    const track = tracks[index];
    const start = () => {
      if (disposed) return;
      try {
        track.audio.muted = false;
        track.audio.currentTime = 0;
        void Promise.resolve(track.audio.play()).catch(() => {});
      } catch {
        /* Audio failure must never prevent messaging. */
      }
    };
    if (track.priming) void track.priming.then(start);
    else start();
  }
  target.addEventListener("pointerdown", unlock, true);
  target.addEventListener("keydown", unlock, true);
  return {
    received: () => play(0),
    sent: () => play(1),
    dispose() {
      disposed = true;
      removeListeners();
      for (const { audio } of tracks) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    },
  };
}
