const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const sharp = require("sharp");
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
    Buffer,
    File,
    Blob,
    Request,
    Response,
    console,
    ...globals,
  });
  return module.exports;
}
const id = "507f1f77bcf86cd799439011",
  chatId = "507f1f77bcf86cd799439020";
const origin = "https://pingme.example";
async function fixture({
  authorized = true,
  member = true,
  creationFails = false,
  accountDeleted = false,
  writeRace = false,
  blocked = false,
} = {}) {
  let now = Date.parse("2026-11-06T10:00:00Z"),
    stored,
    message,
    deleted = 0,
    initialized = false,
    events = 0;
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const helpers = load("src/lib/image-messages.ts", {}, { Date: ClockDate });
  const image = await sharp({
    create: { width: 1600, height: 1000, channels: 3, background: "#2563eb" },
  })
    .webp()
    .toBuffer();
  const models = {
    ChatPreference: { findOne: () => ({ lean: async () => null }) },
    Chat: {
      findOne: async () =>
        member
          ? { users: [id], accountPurgeAt: accountDeleted ? new Date() : null }
          : null,
      exists: async () => member,
      updateOne: async () => ({ matchedCount: writeRace ? 0 : 1 }),
    },
    Message: {
      create: async (value) => {
        if (creationFails) throw new Error("Creation failed");
        message = { ...value, populate: async () => {} };
        return message;
      },
      findById: () => ({ lean: async () => message }),
      deleteOne: async () => {
        message = undefined;
      },
    },
    ChatImage: {
      init: async () => {
        initialized = true;
      },
      create: async (value) => {
        stored = value;
      },
      deleteOne: async () => {
        deleted++;
        stored = undefined;
      },
      findOne: async (filter) =>
        stored && stored.expiresAt > filter.expiresAt.$gt ? stored : null,
    },
  };
  const stubs = {
    "@/lib/chat-permissions": { directMessagingBlocked: async () => blocked },
    "@/lib/auth": { requireUser: async () => (authorized ? id : null) },
    "@/lib/models": models,
    "@/lib/http": {
      oid: (value) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value),
      json: (data, status = 200) => Response.json(data, { status }),
      fail: (message, status = 400) => Response.json({ message }, { status }),
      serverError: (error) => {
        throw error;
      },
    },
    "@/lib/profile-validation": {
      sameOrigin: (req) =>
        !req.headers.get("origin") ||
        req.headers.get("origin") === new URL(req.url).origin,
    },
    "@/lib/realtime": {
      publishChatUpdate: async () => {
        events++;
      },
    },
    "@/lib/image-messages": helpers,
  };
  const uploadRoute = load("src/app/api/messages/image/route.ts", stubs, {
    Date: ClockDate,
  });
  const readRoute = load(
    "src/app/api/messages/image/[messageId]/route.ts",
    stubs,
    { Date: ClockDate },
  );
  const upload = (
    file = new File([image], "chat.webp", { type: "image/webp" }),
    headers = {},
  ) => {
    const form = new FormData();
    form.set("chatId", chatId);
    form.set("image", file);
    return uploadRoute.POST(
      new Request(origin + "/api/messages/image", {
        method: "POST",
        body: form,
        headers,
      }),
    );
  };
  const read = () =>
    readRoute.GET(new Request(origin + "/api/messages/image/test"), {
      params: Promise.resolve({ messageId: String(message?._id || id) }),
    });
  return {
    upload,
    read,
    helpers,
    models,
    image,
    advance: (ms) => {
      now += ms;
    },
    stored: () => stored,
    message: () => message,
    deleted: () => deleted,
    initialized: () => initialized,
    events: () => events,
  };
}
test("image upload reencodes WebP, bounds dimensions, sets exact one-hour expiry and enables TTL", async () => {
  const f = await fixture(),
    res = await f.upload();
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(data.kind, "image");
  assert.equal(data.content, "Image");
  assert.equal(
    Date.parse(data.imageExpiresAt) - Date.parse(data.createdAt),
    3600000,
  );
  const meta = await sharp(f.stored().data).metadata();
  assert.equal(meta.format, "webp");
  assert.ok(meta.width <= 1024 && meta.height <= 1024);
  assert.ok(f.initialized());
  assert.equal(f.events(), 1);
});
test("image access is uncached and stops exactly at expiry, deleting remaining stored bytes", async () => {
  const f = await fixture();
  await f.upload();
  f.advance(3599999);
  const active = await f.read();
  assert.equal(active.status, 200);
  assert.match(active.headers.get("Cache-Control"), /no-store/);
  assert.deepEqual(Buffer.from(await active.arrayBuffer()), f.stored().data);
  f.advance(1);
  const expired = await f.read();
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).message, "Image auto deleted");
  assert.equal(f.stored(), undefined);
  assert.equal(f.deleted(), 1);
  assert.equal(f.message().content, "Image");
});
test("image APIs reject unauthenticated users, non-members and foreign upload origins", async () => {
  for (const [options, status] of [
    [{ authorized: false }, 401],
    [{ member: false }, 404],
  ]) {
    const f = await fixture(options);
    assert.equal((await f.upload()).status, status);
    assert.equal(f.stored(), undefined);
  }
  const f = await fixture();
  assert.equal(
    (await f.upload(undefined, { Origin: "https://other.example" })).status,
    403,
  );
});
test("image uploads reject corrupt files, wrong types and excessive size", async () => {
  const f = await fixture();
  for (const file of [
    new File(["bad"], "bad.webp", { type: "image/webp" }),
    new File(["bad"], "bad.png", { type: "image/png" }),
    new File([Buffer.alloc(1024 * 1024 + 1)], "large.webp", {
      type: "image/webp",
    }),
  ])
    assert.equal((await f.upload(file)).status, 400);
  assert.equal(
    (await f.upload(undefined, { "Content-Length": String(3 * 1024 * 1024) }))
      .status,
    413,
  );
  assert.equal(f.stored(), undefined);
});
test("failed message creation cleans up orphaned image bytes", async () => {
  const f = await fixture({ creationFails: true });
  await assert.rejects(f.upload(), /Creation failed/);
  assert.equal(f.stored(), undefined);
  assert.equal(f.deleted(), 1);
});
test("deleted images cannot be retrieved even before the deadline", async () => {
  const f = await fixture();
  await f.upload();
  f.message().deletedAt = new Date();
  assert.equal((await f.read()).status, 410);
  assert.equal(f.stored(), undefined);
});
test("expiry helper handles old messages, invalid deadlines and countdown boundaries", () => {
  const { imageExpired, imageTimeLeft, IMAGE_LIFETIME_MS } = load(
    "src/lib/image-messages.ts",
  );
  assert.equal(imageExpired({ kind: "text" }), false);
  assert.equal(imageExpired({ kind: "image" }), true);
  const createdAt = new Date(Date.now() - IMAGE_LIFETIME_MS).toISOString();
  assert.equal(
    imageExpired({
      kind: "image",
      createdAt,
      imageExpiresAt: new Date(Date.now() + 100000).toISOString(),
    }),
    true,
  );
  assert.equal(imageTimeLeft(3600000, 0), "60:00");
  assert.equal(imageTimeLeft(3600000, 1000), "59:59");
  assert.equal(imageTimeLeft(1000, 1000), "00:00");
});
test("database attachment schema has a TTL index on image expiry only", () => {
  const { ChatImage, Message } = load("src/lib/models.ts", {
    "./message-retention": load("src/lib/message-retention.ts"),
  });
  const index = ChatImage.schema
    .indexes()
    .find(([fields]) => fields.expiresAt === 1);
  assert.ok(index);
  assert.equal(index[1].expireAfterSeconds, 0);
  assert.ok(Message.schema.path("imageExpiresAt"));
  assert.ok(
    Message.schema
      .indexes()
      .filter(([, options]) => options.expireAfterSeconds !== undefined)
      .every(
        ([, options]) =>
          options.expireAfterSeconds === 86400 ||
          options.expireAfterSeconds === 0,
      ),
  );
});

test("image sends reject deleted-account direct chats and clean up deletion races", async () => {
  const closed = await fixture({ accountDeleted: true });
  assert.equal((await closed.upload()).status, 403);
  assert.equal(closed.stored(), undefined);
  const race = await fixture({ writeRace: true });
  assert.equal((await race.upload()).status, 403);
  assert.equal(race.stored(), undefined);
  assert.equal(race.message(), undefined);
});

test("blocked direct image sends are rejected without storing bytes", async () => {
  const f = await fixture({ blocked: true });
  assert.equal((await f.upload()).status, 403);
  assert.equal(f.stored(), undefined);
});
