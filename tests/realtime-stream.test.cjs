const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
function load(file, stubs = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => (name in stubs ? stubs[name] : require(name)),
    process: { env: {} },
    console,
    TextEncoder,
    ReadableStream,
    Response,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return module.exports;
}
const http = {
  fail: (message, status = 400) => Response.json({ message }, { status }),
  serverError: (error) => {
    throw error;
  },
};
const req = () => new Request("https://pingme.example/api/events");
const decode = (chunk) =>
  JSON.parse(
    new TextDecoder()
      .decode(chunk)
      .trim()
      .replace(/^data: /, ""),
  );
test("authenticated event streams become live without Redis and deliver only to recipients", async () => {
  const realtime = load("src/lib/realtime.ts");
  let user = "one";
  const route = load("src/app/api/events/route.ts", {
    "@/lib/auth": { requireUser: async () => user },
    "@/lib/http": http,
    "@/lib/profile-validation": { sameOrigin: () => true },
    "@/lib/realtime": realtime,
  });
  const first = await route.GET(req());
  user = "two";
  const second = await route.GET(req());
  const a = first.body.getReader(),
    b = second.body.getReader();
  try {
    assert.ok(
      first.headers.get("Content-Type").startsWith("text/event-stream"),
    );
    assert.match(first.headers.get("Cache-Control"), /no-store/);
    assert.deepEqual(decode((await a.read()).value), {
      type: "sync:status",
      live: true,
    });
    assert.deepEqual(decode((await b.read()).value), {
      type: "sync:status",
      live: true,
    });
    await realtime.publishChatUpdate("chat-one", ["one"]);
    assert.deepEqual(decode((await a.read()).value), {
      type: "chat:update",
      chatId: "chat-one",
    });
    await realtime.publishChatUpdate("chat-two", ["two"]);
    assert.deepEqual(decode((await b.read()).value), {
      type: "chat:update",
      chatId: "chat-two",
    });
    await realtime.revokeUserSessions("one");
    assert.equal(decode((await a.read()).value).type, "session:revoke");
    assert.equal((await a.read()).done, true);
  } finally {
    await a.cancel();
    await b.cancel();
  }
});
test("event streams reject unauthenticated and cross-origin requests", async () => {
  let user = null,
    allowed = true,
    subscriptions = 0;
  const route = load("src/app/api/events/route.ts", {
    "@/lib/auth": { requireUser: async () => user },
    "@/lib/http": http,
    "@/lib/profile-validation": { sameOrigin: () => allowed },
    "@/lib/realtime": {
      subscribeRealtime: () => {
        subscriptions++;
      },
    },
  });
  assert.equal((await route.GET(req())).status, 401);
  user = "one";
  allowed = false;
  assert.equal((await route.GET(req())).status, 403);
  assert.equal(subscriptions, 0);
});
test("disconnecting an event stream unsubscribes and clears its timers", async () => {
  let unsubscribed = 0,
    intervalCleared = 0,
    timeoutCleared = 0;
  const route = load(
    "src/app/api/events/route.ts",
    {
      "@/lib/auth": { requireUser: async () => "one" },
      "@/lib/http": http,
      "@/lib/profile-validation": { sameOrigin: () => true },
      "@/lib/realtime": {
        subscribeRealtime: (_id, _event, status) => {
          status(true);
          return () => {
            unsubscribed++;
          };
        },
      },
    },
    {
      setInterval: () => 1,
      clearInterval: () => {
        intervalCleared++;
      },
      setTimeout: () => 2,
      clearTimeout: () => {
        timeoutCleared++;
      },
    },
  );
  const response = await route.GET(req());
  await response.body.cancel();
  assert.equal(unsubscribed, 1);
  assert.equal(intervalCleared, 1);
  assert.equal(timeoutCleared, 1);
});
test("stream heartbeats stay on the open connection and bounded lifetimes close cleanly", async () => {
  let heartbeat,
    lifetime,
    unsubscribed = 0;
  const route = load(
    "src/app/api/events/route.ts",
    {
      "@/lib/auth": { requireUser: async () => "one" },
      "@/lib/http": http,
      "@/lib/profile-validation": { sameOrigin: () => true },
      "@/lib/realtime": {
        subscribeRealtime: (_id, _event, status) => {
          status(true);
          return () => {
            unsubscribed++;
          };
        },
      },
    },
    {
      setInterval: (callback) => {
        heartbeat = callback;
        return 1;
      },
      clearInterval: () => {},
      setTimeout: (callback) => {
        lifetime = callback;
        return 2;
      },
      clearTimeout: () => {},
    },
  );
  const response = await route.GET(req()),
    reader = response.body.getReader();
  await reader.read();
  heartbeat();
  assert.deepEqual(decode((await reader.read()).value), {
    type: "sync:status",
    live: true,
  });
  lifetime();
  assert.equal((await reader.read()).done, true);
  assert.equal(unsubscribed, 1);
});
test("EventSource adapter forwards events and lets the existing controller own retries", () => {
  let source;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      source = this;
    }
    close() {
      this.closed = true;
    }
  }
  const { createEventStream } = load(
    "src/lib/chat-sync.ts",
    {},
    { EventSource: FakeEventSource },
  );
  const stream = createEventStream();
  let opened = 0,
    received,
    errors = 0;
  stream.onopen = () => opened++;
  stream.onmessage = (event) => (received = event.data);
  stream.onerror = () => errors++;
  source.onopen();
  source.onmessage({ data: "update" });
  source.onerror();
  assert.equal(source.url, "/api/events");
  assert.equal(opened, 1);
  assert.equal(received, "update");
  assert.equal(errors, 1);
  assert.equal(source.closed, true);
});

test("Redis connection reads the Vercel variable and trims empty values", () => {
  for (const [env, expected] of [
    [
      { PING_ME_REDIS_URL: "redis://example.invalid:6379" },
      "redis://example.invalid:6379",
    ],
    [
      { PING_ME_REDIS_URL: " redis://example.invalid:6379 " },
      "redis://example.invalid:6379",
    ],
    [{ PING_ME_REDIS_URL: "  " }, undefined],
    [{}, undefined],
  ]) {
    const { getRedisUrl } = load(
      "src/lib/realtime.ts",
      {},
      { process: { env } },
    );
    assert.equal(getRedisUrl(), expected);
  }
});
test("prefixed Redis configuration connects Pub/Sub and deduplicates the local echo", async () => {
  const clients = [];
  class FakeRedis {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      clients.push(this);
    }
    on(name, handler) {
      this.handlers[name] = handler;
      return this;
    }
    async connect() {
      this.status = "ready";
      this.handlers.ready?.();
    }
    async subscribe(channel) {
      assert.equal(channel, "pingme:events");
    }
    async publish(channel, payload) {
      assert.equal(channel, "pingme:events");
      for (const client of clients) client.handlers.message?.(channel, payload);
    }
    disconnect() {}
  }
  const realtime = load(
    "src/lib/realtime.ts",
    { ioredis: FakeRedis },
    { process: { env: { PING_ME_REDIS_URL: "redis://example.invalid:6379" } } },
  );
  const events = [],
    statuses = [];
  const unsubscribe = realtime.subscribeRealtime(
    "one",
    (event) => events.push(event),
    (live) => statuses.push(live),
  );
  await Promise.resolve();
  await Promise.resolve();
  await realtime.publishChatUpdate("chat", ["one"]);
  assert.equal(clients.length, 2);
  assert.ok(
    clients.every((client) => client.url === "redis://example.invalid:6379"),
  );
  assert.ok(statuses.includes(true));
  assert.equal(events.length, 1);
  unsubscribe();
});
