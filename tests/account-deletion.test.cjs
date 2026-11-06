const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm"),
  ts = require("typescript"),
  bcrypt = require("bcryptjs");
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
    Date,
    Buffer,
    process: { env: { NODE_ENV: "test" } },
    console,
    ...globals,
  });
  return module.exports;
}
const id = "507f1f77bcf86cd799439011",
  other = "507f1f77bcf86cd799439012",
  direct = "507f1f77bcf86cd799439020",
  group = "507f1f77bcf86cd799439021";
async function routeFixture({ authorized = true, validOrigin = true } = {}) {
  const password = await bcrypt.hash("Current-password", 4);
  let deletions = 0,
    cookie;
  const route = load("src/app/api/profile/account/route.ts", {
    "@/lib/auth": {
      requireUser: async () => (authorized ? id : null),
      cookieName: "pingme_session",
    },
    "@/lib/models": {
      User: {
        findOne: async (filter) => {
          assert.equal(filter._id, id);
          assert.equal(filter.deletedAt, null);
          return { password };
        },
      },
    },
    "@/lib/account-deletion": {
      deleteAccount: async (owner, hash) => {
        assert.equal(owner, id);
        assert.equal(hash, password);
        deletions++;
        return { accountPurgeAt: new Date(Date.now() + 15 * 86400000) };
      },
    },
    "@/lib/profile-validation": { sameOrigin: () => validOrigin },
    "@/lib/http": {
      body: (request) => request.json().catch(() => null),
      fail: (message, status = 400) => Response.json({ message }, { status }),
      json: (data) => {
        const response = Response.json(data);
        response.cookies = {
          set: (...values) => {
            cookie = values;
          },
        };
        return response;
      },
      serverError: (error) => {
        throw error;
      },
    },
  });
  const invoke = (values) =>
    route.DELETE(
      new Request("https://pingme.example/api/profile/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      }),
    );
  return { invoke, deletions: () => deletions, cookie: () => cookie };
}
test("account deletion requires authentication, same origin, password and final confirmation", async () => {
  for (const [options, status] of [
    [{ authorized: false }, 401],
    [{ validOrigin: false }, 403],
  ]) {
    const f = await routeFixture(options);
    assert.equal(
      (
        await f.invoke({
          currentPassword: "Current-password",
          confirmation: "DELETE",
        })
      ).status,
      status,
    );
    assert.equal(f.deletions(), 0);
  }
  const f = await routeFixture();
  for (const values of [
    {},
    { confirmation: "DELETE" },
    { currentPassword: "wrong", confirmation: "DELETE" },
    { currentPassword: "Current-password", confirmation: "NO" },
  ])
    assert.equal((await f.invoke(values)).status, 400);
  assert.equal(f.deletions(), 0);
});
test("confirmed deletion affects only the authenticated account and clears its cookie", async () => {
  const f = await routeFixture();
  const response = await f.invoke({
    currentPassword: "Current-password",
    confirmation: "DELETE",
    userId: other,
  });
  assert.equal(response.status, 200);
  assert.equal(f.deletions(), 1);
  assert.equal(f.cookie()[0], "pingme_session");
  assert.equal(f.cookie()[1], "");
  assert.equal(f.cookie()[2].maxAge, 0);
});
function transactionFixture(failure = false) {
  const user = {
    _id: id,
    name: "Original",
    email: "original@example.invalid",
    password: "hash",
    image: "photo",
    bio: "About",
    sessionVersion: 0,
  };
  const chats = [
    { _id: direct, isGroup: false, users: [id, other] },
    { _id: group, isGroup: true, users: [id, other], groupAdmin: id },
  ];
  const messages = [
    { chat: direct, sender: id },
    { chat: direct, sender: other },
    { chat: group, sender: id },
    { chat: group, sender: other },
    { chat: "unrelated", sender: other },
  ];
  const events = [];
  let avatar = true,
    ended = 0,
    committed = false;
  const session = {
    withTransaction: async (action) => {
      const snapshot = JSON.parse(
        JSON.stringify({ user, chats, messages, avatar }),
      );
      try {
        await action();
        committed = true;
      } catch (error) {
        for (const key of Object.keys(user)) delete user[key];
        Object.assign(user, snapshot.user);
        chats.splice(0, chats.length, ...snapshot.chats);
        messages.splice(0, messages.length, ...snapshot.messages);
        avatar = snapshot.avatar;
        throw error;
      }
    },
    endSession: async () => {
      ended++;
    },
  };
  const models = {
    ChatPreference: {
      init: async () => {},
      deleteMany: async () => {},
      updateMany: async () => {},
    },
    UserBlock: { deleteMany: async () => {} },
    User: {
      findOneAndUpdate: async (filter, update, options) => {
        assert.equal(options.session, session);
        if (user.deletedAt || filter.password !== user.password) return null;
        Object.assign(user, update.$set);
        user.sessionVersion += update.$inc.sessionVersion;
        return user;
      },
      findOne: (filter) => ({
        select() {
          return this;
        },
        session: async (value) => {
          assert.equal(value, session);
          assert.equal(filter.deletedAt, null);
          return { _id: other };
        },
      }),
    },
    Chat: {
      find: () => ({
        select() {
          return this;
        },
        session() {
          return this;
        },
        lean: async () =>
          chats.map((chat) => ({ ...chat, users: [...chat.users] })),
      }),
      updateMany: async (filter, update, options) => {
        assert.equal(options.session, session);
        if (update.$min) {
          for (const chat of chats)
            if (filter._id.$in.includes(chat._id))
              chat.accountPurgeAt = update.$min.accountPurgeAt;
        } else {
          for (const chat of chats)
            if (chat.isGroup)
              chat.users = chat.users.filter((user) => user !== id);
        }
      },
      updateOne: async (filter, update, options) => {
        assert.equal(options.session, session);
        const chat = chats.find((chat) => chat._id === filter._id);
        chat.groupAdmin = update.$set.groupAdmin;
      },
    },
    Message: {
      updateMany: async (filter, update, options) => {
        assert.equal(options.session, session);
        if (failure) throw Error("Scheduling failed");
        for (const message of messages)
          if (
            filter.$or[0].chat.$in.includes(message.chat) ||
            message.sender === filter.$or[1].sender
          )
            message.accountPurgeAt = update.$min.accountPurgeAt;
      },
    },
    ProfileImage: {
      deleteOne: async (_filter, options) => {
        assert.equal(options.session, session);
        avatar = false;
      },
    },
  };
  const service = load("src/lib/account-deletion.ts", {
    mongoose: { startSession: async () => session },
    "./models": models,
    "./realtime": {
      publishChatUpdate: async (...event) => {
        assert.ok(committed);
        events.push(event);
      },
      revokeUserSessions: async (owner) => {
        assert.equal(owner, id);
        assert.ok(committed);
        events.push("revoked");
      },
    },
  });
  return {
    ...service,
    user,
    chats,
    messages,
    events,
    avatar: () => avatar,
    ended: () => ended,
  };
}
test("deletion atomically anonymizes the account and schedules full direct histories for 15 days", async () => {
  const f = transactionFixture(),
    result = await f.deleteAccount(id, "hash");
  assert.equal(result.accountPurgeAt - result.deletedAt, 15 * 86400000);
  assert.equal(f.user.name, "Deleted account");
  assert.notEqual(f.user.email, "original@example.invalid");
  assert.notEqual(f.user.password, "hash");
  assert.equal(f.user.bio, "");
  assert.equal(f.user.image, "");
  assert.ok(f.user.deletedAt);
  assert.equal(f.user.sessionVersion, 1);
  assert.equal(f.avatar(), false);
  assert.ok(f.chats[0].accountPurgeAt);
  assert.equal(f.chats[1].accountPurgeAt, undefined);
  assert.deepEqual(f.chats[1].users, [other]);
  assert.equal(f.chats[1].groupAdmin, other);
  assert.ok(f.messages[0].accountPurgeAt);
  assert.ok(f.messages[1].accountPurgeAt);
  assert.ok(f.messages[2].accountPurgeAt);
  assert.equal(f.messages[3].accountPurgeAt, undefined);
  assert.equal(f.messages[4].accountPurgeAt, undefined);
  assert.equal(f.events.length, 3);
  assert.equal(f.ended(), 1);
});
test("failed scheduling rolls back account deletion and sends no notifications", async () => {
  const f = transactionFixture(true);
  await assert.rejects(f.deleteAccount(id, "hash"), /Scheduling failed/);
  assert.equal(f.user.name, "Original");
  assert.equal(f.user.deletedAt, undefined);
  assert.equal(f.chats[0].accountPurgeAt, undefined);
  assert.equal(f.events.length, 0);
  assert.equal(f.ended(), 1);
});
test("text sending rejects a deleted-account direct chat without persisting a message", async () => {
  let writes = 0;
  const route = load("src/app/api/messages/route.ts", {
    "@/lib/chat-permissions": { directMessagingBlocked: async () => false },
    "@/lib/auth": { requireUser: async () => other },
    "@/lib/models": {
      Chat: {
        findOne: async () => ({
          _id: direct,
          isGroup: false,
          accountPurgeAt: new Date(),
        }),
      },
      Message: {
        create: async () => {
          writes++;
        },
      },
    },
    "@/lib/realtime": {},
    "@/lib/http": {
      body: (request) => request.json(),
      oid: () => true,
      fail: (message, status = 400) => Response.json({ message }, { status }),
      serverError: (error) => {
        throw error;
      },
    },
  });
  const response = await route.POST(
    new Request("https://pingme.example/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatId: direct, content: "Blocked" }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});
test("account cleanup deadline is honored alongside shorter message retention", () => {
  const policy = load("src/lib/message-retention.ts"),
    deadline = Date.now() + 15 * 86400000;
  assert.equal(
    policy.messageRemovalTime({ accountPurgeAt: new Date(deadline) }),
    deadline,
  );
  assert.equal(
    policy.messageRetentionExpired(
      { accountPurgeAt: new Date(deadline) },
      deadline,
    ),
    true,
  );
  const early = new Date(Date.now());
  assert.equal(
    policy.messageRemovalTime({
      accountPurgeAt: new Date(deadline),
      deletedAt: early,
    }),
    early.getTime() + 86400000,
  );
});

test("deleted-account sessions are rejected even with a correctly signed JWT", async () => {
  const jose = await import("jose"),
    secret = "test-secret-for-deleted-account-session-check";
  const token = await new jose.SignJWT({ sub: id, ver: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  let checked = false;
  const auth = load(
    "src/lib/auth.ts",
    {
      jose,
      "next/headers": {
        cookies: async () => ({ get: () => ({ value: token }) }),
      },
      "./db": { connectDb: async () => {} },
      "./models": {
        User: {
          exists: async (filter) => {
            checked = true;
            assert.equal(filter.deletedAt, null);
            return false;
          },
        },
      },
    },
    { TextEncoder, process: { env: { JWT_SECRET: secret } } },
  );
  assert.equal(await auth.requireUser(), null);
  assert.ok(checked);
});
