const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const vm = require("node:vm");

// Use the existing TypeScript compiler; no test runtime dependency is needed.
const filename = path.resolve(__dirname, "../src/lib/chat-sync.ts");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText,
  filename,
);
const { createChatSync, createReadDeduper, mergeMessages } = compiled.exports;

test("default browser timers retain their global receiver when scheduling and clearing", async () => {
  const clock = new Clock();
  const socket = new Socket();
  let refreshes = 0;
  const context = vm.createContext({
    exports: {},
    schedule: clock.setTimeout,
    cancel: clock.clearTimeout,
    openSocket: () => socket,
    refresh: async () => {
      refreshes++;
    },
  });
  vm.runInContext(
    `
    globalThis.setTimeout = function(...args) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return schedule(...args);
    };
    globalThis.clearTimeout = function(...args) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return cancel(...args);
    };
    ${
      ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      }).outputText
    }
    globalThis.sync = exports.createChatSync({
      openSocket, refresh, onLive() {}, isVisible: () => true, isOnline: () => true,
    });
    sync.start();
  `,
    context,
  );
  await clock.tick(150);
  assert.equal(refreshes, 1);
  socket.status(true);
  context.sync.stop();
  assert.equal(clock.tasks.size, 0);
});

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("browser synchronization calls window timers even when the global timer host differs", async () => {
  const clock = new Clock(),
    socket = new Socket();
  let refreshes = 0;
  const context = vm.createContext({
    exports: {},
    schedule: clock.setTimeout,
    cancel: clock.clearTimeout,
    openSocket: () => socket,
    refresh: async () => {
      refreshes++;
    },
  });
  vm.runInContext(
    `
    globalThis.window = {
      setTimeout(...args) {
        if (this !== window) throw new TypeError("Illegal invocation");
        return schedule(...args);
      },
      clearTimeout(...args) {
        if (this !== window) throw new TypeError("Illegal invocation");
        return cancel(...args);
      },
    };
    globalThis.setTimeout = globalThis.clearTimeout = () => { throw new Error("Wrong timer host"); };
    ${
      ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      }).outputText
    }
    globalThis.sync = exports.createChatSync({
      openSocket, refresh, onLive() {}, isVisible: () => true, isOnline: () => true,
    });
    sync.start();
  `,
    context,
  );
  await clock.tick(150);
  assert.equal(refreshes, 1);
  socket.status(true);
  context.sync.stop();
  assert.equal(clock.tasks.size, 0);
});

function workerFixture({ networkFails = false } = {}) {
  const handlers = {},
    deleted = [],
    network = [],
    writes = [];
  let claimed = false;
  const cache = {
    addAll: async () => {},
    put: async (...args) => {
      writes.push(args);
    },
    match: async (request) =>
      request === "/offline.html" ? "offline-page" : "offline-artwork",
  };
  const context = vm.createContext({
    URL,
    self: {
      location: { origin: "http://localhost:3001" },
      addEventListener: (type, handler) => {
        handlers[type] = handler;
      },
      skipWaiting: async () => {},
      clients: {
        claim: async () => {
          claimed = true;
        },
      },
    },
    caches: {
      open: async () => cache,
      keys: async () => [
        "pingme-static-v1",
        "pingme-static-v2",
        "other-app-cache",
      ],
      delete: async (key) => {
        deleted.push(key);
      },
    },
    fetch: async (request) => {
      network.push(request.url);
      if (networkFails) throw new Error("offline");
      return { ok: true, clone: () => "fresh-artwork-copy" };
    },
  });
  vm.runInContext(
    fs.readFileSync(path.resolve(__dirname, "../public/sw.js"), "utf8"),
    context,
  );
  return { handlers, deleted, network, writes, claimed: () => claimed };
}

test("service worker never serves cached Next.js bundles, source maps, APIs, or pages", () => {
  const f = workerFixture();
  for (const pathname of [
    "/_next/static/chunks/app/page.js",
    "/_next/static/css/app.css",
    "/_next/static/app.js.map",
    "/api/chats",
    "/",
  ]) {
    f.handlers.fetch({
      request: {
        url: "http://localhost:3001" + pathname,
        method: "GET",
        mode: "cors",
      },
      respondWith: () =>
        assert.fail("App code and data must bypass the worker cache"),
    });
  }
  assert.equal(f.network.length, 0);
});

test("worker activation removes the old app cache and preserves unrelated caches", async () => {
  const f = workerFixture();
  let completion;
  f.handlers.activate({
    waitUntil: (promise) => {
      completion = promise;
    },
  });
  await completion;
  assert.deepEqual(f.deleted, ["pingme-static-v1", "pingme-static-v2"]);
  assert.equal(f.claimed(), true);
});

test("public artwork uses the network first and falls back to cache only offline", async () => {
  for (const networkFails of [false, true]) {
    const f = workerFixture({ networkFails });
    let response;
    f.handlers.fetch({
      request: {
        url: "http://localhost:3001/icon.svg",
        method: "GET",
        mode: "cors",
      },
      respondWith: (promise) => {
        response = promise;
      },
    });
    const result = await response;
    assert.equal(f.network.length, 1);
    if (networkFails) assert.equal(result, "offline-artwork");
    else {
      assert.equal(result.ok, true);
      assert.equal(f.writes.length, 1);
    }
  }
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Clock {
  now = 0;
  sequence = 0;
  tasks = new Map();
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id) => {
    this.tasks.delete(id);
  };
  async tick(duration) {
    const end = this.now + duration;
    for (;;) {
      const next = [...this.tasks]
        .filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
      await settle();
    }
    this.now = end;
    await settle();
  }
}
class Socket {
  closed = false;
  open() {
    this.onopen?.({});
  }
  status(live) {
    this.message({ type: "sync:status", live });
  }
  message(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  fail() {
    this.onerror?.({});
  }
}
function fixture(refresh) {
  const clock = new Clock(),
    sockets = [],
    calls = [],
    live = [];
  const state = { visible: true, online: true };
  const sync = createChatSync({
    clock,
    openSocket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    refresh: async (ids) => {
      calls.push(ids === undefined ? "all" : [...ids].sort());
      await refresh?.(ids);
    },
    onLive: (value) => live.push(value),
    isVisible: () => state.visible,
    isOnline: () => state.online,
  });
  sync.start();
  return { clock, sockets, calls, live, state, sync };
}

test("concurrent reads share one request and later reads fetch fresh data", async () => {
  const read = createReadDeduper(),
    pending = deferred();
  let calls = 0;
  const fetcher = () => {
    calls++;
    return pending.promise;
  };
  const a = read("session1:/chats", fetcher),
    b = read("session1:/chats", fetcher);
  assert.equal(a, b);
  await settle();
  assert.equal(calls, 1);
  pending.resolve(["chat"]);
  assert.deepEqual(await a, ["chat"]);
  await read("session1:/chats", async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test("read failures can retry and different sessions never share data", async () => {
  const read = createReadDeduper();
  await assert.rejects(
    read("one:/chats", async () => {
      throw new Error("offline");
    }),
  );
  const result = await Promise.all([
    read("one:/chats", async () => "one"),
    read("two:/chats", async () => "two"),
  ]);
  assert.deepEqual(result, ["one", "two"]);
});

test("healthy live delivery stops all periodic API refreshes", async () => {
  const f = fixture();
  f.sockets[0].open();
  f.sockets[0].status(true);
  await f.clock.tick(150);
  assert.deepEqual(f.calls, ["all"]);
  for (let i = 0; i < 6; i++) {
    await f.clock.tick(20000);
    f.sockets[0].status(true);
  }
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.live, [true]);
  f.sync.stop();
});

test("an open socket without broker readiness keeps the 15-second fallback", async () => {
  const f = fixture();
  f.sockets[0].open();
  f.sockets[0].status(false);
  await f.clock.tick(14999);
  assert.equal(f.calls.length, 1);
  await f.clock.tick(151);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.live, []);
  f.sync.stop();
});

test("rapid notifications become one refresh carrying only the affected chat IDs", async () => {
  const f = fixture();
  f.sockets[0].status(true);
  await f.clock.tick(150);
  for (const chatId of ["a", "a", "b", "a"])
    f.sockets[0].message({ type: "chat:update", chatId });
  await f.clock.tick(149);
  assert.equal(f.calls.length, 1);
  await f.clock.tick(1);
  assert.deepEqual(f.calls[1], ["a", "b"]);
  f.sync.stop();
});

test("events during a slow refresh produce one trailing refresh without overlap", async () => {
  const pending = deferred();
  let concurrent = 0,
    maximum = 0,
    runs = 0;
  const f = fixture(async () => {
    maximum = Math.max(maximum, ++concurrent);
    if (++runs === 1) await pending.promise;
    concurrent--;
  });
  f.sockets[0].status(true);
  await f.clock.tick(150);
  for (let i = 0; i < 20; i++)
    f.sockets[0].message({ type: "chat:update", chatId: "a" });
  await f.clock.tick(1000);
  assert.equal(f.calls.length, 1);
  pending.resolve();
  await settle();
  await f.clock.tick(150);
  assert.equal(maximum, 1);
  assert.deepEqual(f.calls, ["all", ["a"]]);
  f.sync.stop();
});

test("hidden and offline tabs pause requests and reconcile once on return", async () => {
  const f = fixture();
  await f.clock.tick(150);
  f.state.visible = false;
  f.sync.activityChanged();
  assert.equal(f.sockets[0].closed, true);
  await f.clock.tick(120000);
  assert.equal(f.calls.length, 1);
  f.state.visible = true;
  f.state.online = false;
  f.sync.activityChanged();
  await f.clock.tick(60000);
  assert.equal(f.calls.length, 1);
  f.state.online = true;
  f.sync.activityChanged();
  f.sockets[1].status(true);
  await f.clock.tick(150);
  assert.equal(f.calls.length, 2);
  f.sync.stop();
});

test("a dropped socket reconnects and reconciles missed changes", async () => {
  const f = fixture();
  f.sockets[0].status(true);
  await f.clock.tick(150);
  f.sockets[0].close();
  assert.deepEqual(f.live, [true, false]);
  await f.clock.tick(1000);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].status(true);
  await f.clock.tick(150);
  assert.deepEqual(f.calls, ["all", "all"]);
  f.sync.stop();
});

test("a stalled heartbeat restores fallback rather than leaving chats stale", async () => {
  const f = fixture();
  f.sockets[0].status(true);
  await f.clock.tick(45000);
  assert.equal(f.sockets[0].closed, true);
  assert.deepEqual(f.live, [true, false]);
  await f.clock.tick(15150);
  assert.equal(f.calls.length, 2);
  f.sync.stop();
});

test("broker loss restores fallback even if the transport stays open", async () => {
  const f = fixture();
  f.sockets[0].status(true);
  await f.clock.tick(150);
  f.sockets[0].status(false);
  await f.clock.tick(15150);
  assert.equal(f.sockets[0].closed, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.live, [true, false]);
  f.sync.stop();
});

test("cleanup cancels queued reads and reconnects, including Strict Mode remounts", async () => {
  const f = fixture();
  f.sync.stop();
  await f.clock.tick(120000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.clock.tasks.size, 0);
});

test("failed refreshes do not block subsequent updates", async () => {
  let runs = 0;
  const f = fixture(async () => {
    if (++runs === 1) throw new Error("network error");
  });
  await f.clock.tick(15150);
  assert.equal(f.calls.length, 2);
  f.sync.stop();
});

test("a failed API read retries even when live delivery stays healthy", async () => {
  let runs = 0;
  const f = fixture(async () => {
    if (++runs === 1) throw new Error("temporary API failure");
  });
  f.sockets[0].status(true);
  await f.clock.tick(15300);
  assert.equal(f.calls.length, 2);
  for (let i = 0; i < 3; i++) {
    f.sockets[0].status(true);
    await f.clock.tick(20000);
  }
  assert.equal(f.calls.length, 2);
  f.sync.stop();
});

test("an in-flight history response preserves newly sent messages without duplicates", () => {
  const first = { _id: "1", createdAt: "2026-11-03T10:00:00Z" };
  const second = { _id: "2", createdAt: "2026-11-03T10:01:00Z" };
  assert.deepEqual(mergeMessages([first], [second]), [first, second]);
  assert.deepEqual(mergeMessages([first, second], [second]), [first, second]);
});

test("navigation uses fresh online HTML and only a public reconnect page offline", async () => {
  for (const networkFails of [false, true]) {
    const f = workerFixture({ networkFails });
    let result;
    f.handlers.fetch({
      request: {
        url: "http://localhost:3001/?connect=someone",
        method: "GET",
        mode: "navigate",
      },
      respondWith: (promise) => {
        result = promise;
      },
    });
    const response = await result;
    assert.equal(f.network.length, 1);
    assert.equal(
      f.writes.length,
      0,
      "Private navigations must never be cached",
    );
    if (networkFails) assert.equal(response, "offline-page");
    else assert.equal(response.ok, true);
  }
});

test("message reconciliation retains newer edits and never restores deleted text", () => {
  const original = {
    _id: "message",
    createdAt: "2026-11-06T10:00:00Z",
    content: "Original",
  };
  const edited = {
    ...original,
    editedAt: "2026-11-06T10:01:00Z",
    content: "Edited",
  };
  const deleted = {
    ...edited,
    deletedAt: "2026-11-06T10:02:00Z",
    content: "Message has been deleted",
  };
  assert.equal(mergeMessages([edited], [original])[0].content, "Edited");
  assert.equal(mergeMessages([original], [edited])[0].content, "Edited");
  assert.ok(mergeMessages([deleted], [edited])[0].deletedAt);
  assert.ok(mergeMessages([edited], [deleted])[0].deletedAt);
});

test("session revocation from a push stream expires the current session", () => {
  const clock = new Clock(),
    socket = new Socket();
  let expired = 0;
  const sync = createChatSync({
    openSocket: () => socket,
    refresh: async () => {},
    onLive: () => {},
    onSessionExpired: () => expired++,
    isVisible: () => true,
    isOnline: () => true,
    clock,
  });
  sync.start();
  socket.onmessage({ data: JSON.stringify({ type: "session:revoke" }) });
  assert.equal(expired, 1);
  sync.stop();
});
