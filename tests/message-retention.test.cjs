const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript");
function load(file, stubs = {}) {
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
    Date,
    console,
    Promise,
    Buffer,
  });
  return module.exports;
}
const policy = load("src/lib/message-retention.ts");
const day = 86400000,
  now = Date.parse("2026-11-06T10:00:00Z");
test("deleted text and image placeholders expire exactly 24 hours after deletion", () => {
  for (const kind of ["text", "image"]) {
    const message = { kind, deletedAt: new Date(now) };
    assert.equal(policy.messageRemovalTime(message), now + day);
    assert.equal(policy.messageRetentionExpired(message, now + day - 1), false);
    assert.equal(policy.messageRetentionExpired(message, now + day), true);
  }
});
test("auto-deleted image placeholders expire 24 hours after image expiry", () => {
  const message = { kind: "image", imageExpiresAt: new Date(now) };
  assert.equal(policy.messageRemovalTime(message), now + day);
  assert.equal(
    policy.messageRemovalTime({ ...message, deletedAt: new Date(now - 1000) }),
    now - 1000 + day,
  );
});
test("live messages and null dates never expire under placeholder retention", () => {
  for (const message of [
    {},
    { kind: "text", deletedAt: null, imageExpiresAt: null },
    { deletedAt: "invalid" },
  ])
    assert.equal(policy.messageRetentionExpired(message, now), false);
});
test("read filters hide placeholders past the retention cutoff", () => {
  const filter = policy.retainedMessageFilter(now);
  assert.equal(filter.$nor.length, 3);
  assert.equal(filter.$nor[0].deletedAt.$lte.getTime(), now - day);
  assert.equal(filter.$nor[1].imageExpiresAt.$lte.getTime(), now - day);
});
test("message TTL indexes expire only deletion dates, never normal message timestamps", () => {
  const { Message } = load("src/lib/models.ts", {
    "./message-retention": policy,
  });
  const indexes = Message.schema
    .indexes()
    .filter(([, options]) => options.expireAfterSeconds !== undefined);
  assert.equal(indexes.length, 3);
  assert.ok(
    indexes.every(([fields, options]) =>
      fields.accountPurgeAt === 1
        ? options.expireAfterSeconds === 0
        : (fields.deletedAt === 1 || fields.imageExpiresAt === 1) &&
          options.expireAfterSeconds === 86400,
    ),
  );
  assert.ok(!indexes.some(([fields]) => fields.createdAt || fields.updatedAt));
});
test("retention indexes initialize once and retry after a database failure", async () => {
  let calls = 0,
    fail = true;
  const models = {
    Message: {
      collection: {
        createIndex: async (fields, options) => {
          calls++;
          assert.equal(
            options.expireAfterSeconds,
            fields.accountPurgeAt ? 0 : 86400,
          );
          assert.ok(
            fields.deletedAt || fields.imageExpiresAt || fields.accountPurgeAt,
          );
          if (fail) throw Error("Transient failure");
        },
      },
    },
  };
  models.Chat = models.Message;
  models.User = models.Message;
  const indexes = load("src/lib/message-retention-indexes.ts", {
    "./models": models,
    "./message-retention": policy,
  });
  await assert.rejects(
    indexes.ensureMessageRetentionIndexes(),
    /Transient failure/,
  );
  fail = false;
  await Promise.all([
    indexes.ensureMessageRetentionIndexes(),
    indexes.ensureMessageRetentionIndexes(),
  ]);
  assert.equal(calls, 6);
  await indexes.ensureMessageRetentionIndexes();
  assert.equal(calls, 6);
});
test("chat previews fall back to latest retained messages in one batched query", async () => {
  const chats = [
    { _id: "chat-one", latestMessage: null },
    { _id: "chat-two", latestMessage: { _id: "live" } },
  ];
  let aggregates = 0;
  const models = {
    ChatPreference: {
      find: () => ({
        select() {
          return this;
        },
        lean: async () => [],
      }),
    },
    Chat: {
      find: () => ({
        populate() {
          return this;
        },
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        lean: async () => chats,
      }),
    },
    User: {},
    Message: {
      aggregate: async (pipeline) => {
        aggregates++;
        assert.equal(pipeline[0].$match.chat.$in.join(","), "chat-one");
        assert.equal(pipeline[0].$match.$nor.length, 3);
        return [
          {
            _id: "chat-one",
            message: { _id: "previous", content: "Previous live message" },
          },
        ];
      },
      populate: async () => {},
    },
  };
  const route = load("src/app/api/chats/route.ts", {
    "@/lib/chat-permissions": { blockFilter: () => ({}) },
    "@/lib/auth": { requireUser: async () => "user" },
    "@/lib/models": models,
    "@/lib/message-retention": policy,
    "@/lib/http": {
      json: (value) => value,
      serverError: (error) => {
        throw error;
      },
    },
    "@/lib/realtime": {},
  });
  const result = await route.GET();
  assert.equal(aggregates, 1);
  assert.equal(result.data[0].latestMessage._id, "previous");
  assert.equal(result.data[1].latestMessage._id, "live");
});
