// Browser synchronization is independent of React so reconnects and requests can
// be coordinated without restarting the connection when the selected chat changes.
type Socket = Pick<
  WebSocket,
  "onopen" | "onmessage" | "onerror" | "onclose" | "close"
>;
type Timer = ReturnType<typeof setTimeout> | number;
type Clock = {
  setTimeout: (callback: () => void, delay: number) => Timer;
  clearTimeout: (timer: Timer) => void;
};

export function mergeMessages<T extends { _id: string; createdAt: string }>(
  loaded: T[],
  local: T[],
) {
  const messages = new Map(loaded.map((message) => [message._id, message]));
  for (const message of local) messages.set(message._id, message);
  return [...messages.values()].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

export function createReadDeduper() {
  const pending = new Map<string, Promise<unknown>>();
  return function read<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = pending.get(key);
    if (existing) return existing as Promise<T>;
    const result = Promise.resolve().then(fetcher);
    pending.set(key, result);
    const clear = () => {
      if (pending.get(key) === result) pending.delete(key);
    };
    result.then(clear, clear);
    return result;
  };
}

export function createChatSync(options: {
  openSocket: () => Socket;
  refresh: (chatIds?: ReadonlySet<string>) => Promise<unknown>;
  onLive: (live: boolean) => void;
  isVisible: () => boolean;
  isOnline: () => boolean;
  clock?: Clock;
}) {
  // Call through the browser host directly; never copy native timer methods.
  const clock: Clock = options.clock ?? {
    setTimeout: (callback, delay) =>
      typeof window !== "undefined"
        ? window.setTimeout(callback, delay)
        : globalThis.setTimeout(callback, delay),
    clearTimeout: (timer) => {
      if (typeof window !== "undefined") window.clearTimeout(timer as number);
      else globalThis.clearTimeout(timer);
    },
  };
  let stopped = false;
  let live = false;
  let socket: Socket | null = null;
  let retries = 0;
  let poll: Timer | undefined;
  let retry: Timer | undefined;
  let heartbeat: Timer | undefined;
  let batch: Timer | undefined;
  let failedRead: Timer | undefined;
  let refreshing = false;
  let refreshAll = false;
  const changedChats = new Set<string>();
  const active = () => !stopped && options.isVisible() && options.isOnline();
  const clear = (timer: Timer | undefined) => {
    if (timer !== undefined) clock.clearTimeout(timer);
  };

  function schedulePoll() {
    clear(poll);
    poll = undefined;
    if (!active() || live) return;
    poll = clock.setTimeout(() => {
      poll = undefined;
      queueRefresh();
      schedulePoll();
    }, 15000);
  }

  function setLive(value: boolean) {
    if (live === value) return;
    live = value;
    options.onLive(value);
    schedulePoll();
  }

  function queueRefresh(chatId?: string) {
    if (!active()) return;
    if (chatId) changedChats.add(chatId);
    else refreshAll = true;
    if (refreshing || batch !== undefined) return;
    batch = clock.setTimeout(flush, 150);
  }

  async function flush() {
    batch = undefined;
    if (!active()) return;
    const ids = refreshAll ? undefined : new Set(changedChats);
    refreshAll = false;
    changedChats.clear();
    refreshing = true;
    try {
      await options.refresh(ids);
      clear(failedRead);
      failedRead = undefined;
    } catch {
      // A failed read must retry even when the socket is otherwise healthy.
      clear(failedRead);
      if (active())
        failedRead = clock.setTimeout(() => {
          failedRead = undefined;
          queueRefresh();
        }, 15000);
    } finally {
      refreshing = false;
      if (active() && (refreshAll || changedChats.size))
        batch = clock.setTimeout(flush, 150);
    }
  }

  function disconnect() {
    const previous = socket;
    socket = null;
    clear(heartbeat);
    heartbeat = undefined;
    previous?.close();
    setLive(false);
  }

  function scheduleReconnect() {
    clear(retry);
    retry = undefined;
    if (!active()) return;
    retry = clock.setTimeout(
      connect,
      Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)),
    );
  }

  function watchHeartbeat() {
    clear(heartbeat);
    heartbeat = clock.setTimeout(() => {
      disconnect();
      scheduleReconnect();
    }, 45000);
  }

  function connect() {
    retry = undefined;
    if (!active() || socket) return;
    try {
      const connection = options.openSocket();
      socket = connection;
      watchHeartbeat();
      connection.onopen = () => {
        if (socket === connection && !stopped) watchHeartbeat();
      };
      connection.onmessage = (event) => {
        if (socket !== connection || !active()) return;
        try {
          const data = JSON.parse(String(event.data));
          if (data.type === "sync:status" && typeof data.live === "boolean") {
            watchHeartbeat();
            // A transport connection alone cannot guarantee Redis delivery.
            const becameLive = data.live && !live;
            setLive(data.live);
            if (data.live) retries = 0;
            if (becameLive) queueRefresh(); // Catch changes missed while disconnected.
          } else if (
            data.type === "chat:update" &&
            typeof data.chatId === "string"
          ) {
            queueRefresh(data.chatId);
          }
        } catch {
          /* Ignore malformed socket notifications. */
        }
      };
      connection.onclose = () => {
        if (socket !== connection) return;
        socket = null;
        clear(heartbeat);
        setLive(false);
        schedulePoll();
        scheduleReconnect();
      };
      connection.onerror = () => {
        if (socket !== connection) return;
        disconnect();
        schedulePoll();
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  }

  return {
    start() {
      queueRefresh();
      schedulePoll();
      connect();
    },
    activityChanged() {
      if (!active()) {
        disconnect();
        clear(poll);
        poll = undefined;
        clear(retry);
        retry = undefined;
        clear(batch);
        batch = undefined;
        clear(failedRead);
        failedRead = undefined;
        refreshAll = false;
        changedChats.clear();
      } else {
        queueRefresh();
        schedulePoll();
        connect();
      }
    },
    stop() {
      stopped = true;
      disconnect();
      clear(poll);
      clear(retry);
      clear(batch);
      clear(failedRead);
      refreshAll = false;
      changedChats.clear();
    },
  };
}
