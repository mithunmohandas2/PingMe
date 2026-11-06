const { test } = require("node:test"),
  assert = require("node:assert/strict");
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
  });
  return module.exports;
}
const me = "507f1f77bcf86cd799439011",
  other = "507f1f77bcf86cd799439012",
  stranger = "507f1f77bcf86cd799439013",
  chatId = "507f1f77bcf86cd799439020";
function fixture({ group = false, members = [me, other] } = {}) {
  const chat = {
    _id: chatId,
    isGroup: group,
    users: [...members],
    groupAdmin: group ? me : null,
    blockedBy: [],
  };
  const preferences = new Map(),
    blocks = new Set(),
    events = [];
  let historyWrites = 0;
  const session = {
    withTransaction: async (action) => action(),
    endSession: async () => {},
  };
  const models = {
    Chat: {
      findOne: (filter) => {
        const value =
          filter._id === chatId &&
          chat.users.includes(filter.users) &&
          (filter.isGroup === undefined || filter.isGroup === chat.isGroup)
            ? chat
            : null;
        return {
          then: (resolve, reject) =>
            Promise.resolve(value).then(resolve, reject),
          session: async () => value,
        };
      },
      updateOne: async (filter, update, options) => {
        assert.equal(options.session, session);
        chat.users = chat.users.filter((id) => id !== update.$pull.users);
        Object.assign(chat, update.$set);
      },
      updateMany: async (filter, update, options) => {
        assert.equal(options.session, session);
        assert.ok(filter.users.$all.every((id) => chat.users.includes(id)));
        if (update.$addToSet)
          chat.blockedBy = [
            ...new Set([...chat.blockedBy, update.$addToSet.blockedBy]),
          ];
        else
          chat.blockedBy = chat.blockedBy.filter(
            (id) => id !== update.$pull.blockedBy,
          );
      },
    },
    ChatPreference: {
      init: async () => {},
      findOneAndUpdate: async (filter, update) => {
        const key = filter.user + ":" + filter.chat;
        assert.equal(filter.chat, chatId);
        const previous = preferences.get(key);
        const preference = {
          clearedAt:
            previous?.clearedAt > update.$max.clearedAt
              ? previous.clearedAt
              : update.$max.clearedAt,
        };
        preferences.set(key, preference);
        return preference;
      },
      updateMany: async () => {},
    },
    Message: {
      updateMany: async () => {
        historyWrites++;
      },
    },
    UserBlock: {
      init: async () => {},
      updateOne: async (filter) => {
        blocks.add(filter.blocker + ":" + filter.blocked);
      },
      deleteOne: async (filter) => {
        blocks.delete(filter.blocker + ":" + filter.blocked);
      },
      exists: async (filter) =>
        filter.$or.some((pair) =>
          blocks.has(pair.blocker + ":" + pair.blocked),
        ),
    },
  };
  const permissions = load("src/lib/chat-permissions.ts", {
    "./models": models,
  });
  const service = load("src/lib/chat-actions.ts", {
    mongoose: { startSession: async () => session },
    "./models": models,
    "./chat-permissions": permissions,
    "./realtime": { publishChatUpdate: async (...event) => events.push(event) },
  });
  return {
    ...service,
    ...permissions,
    chat,
    preferences,
    blocks,
    events,
    models,
    historyWrites: () => historyWrites,
  };
}
test("clear is private, keeps shared history, and notifies only the acting user", async () => {
  const f = fixture();
  const result = await f.performChatAction(me, chatId, "clear");
  assert.ok(result.clearedAt);
  assert.equal(f.preferences.size, 1);
  assert.equal(f.preferences.has(other + ":" + chatId), false);
  assert.equal(f.historyWrites(), 0);
  assert.equal(f.events[0][1].join(","), me);
  const first = f.preferences.get(me + ":" + chatId).clearedAt;
  await f.performChatAction(other, chatId, "clear");
  assert.equal(f.preferences.get(me + ":" + chatId).clearedAt, first);
  assert.equal(f.preferences.size, 2);
});
test("group exit removes membership, transfers admin and notifies former and current members", async () => {
  const f = fixture({ group: true });
  await f.performChatAction(me, chatId, "leave");
  assert.deepEqual(f.chat.users, [other]);
  assert.equal(f.chat.groupAdmin, other);
  assert.equal(f.historyWrites(), 0);
  assert.equal(f.events[0][1].join(","), [me, other].join(","));
  await assert.rejects(
    f.performChatAction(me, chatId, "leave"),
    /Chat not found/,
  );
});
test("last group member exit schedules abandoned history cleanup", async () => {
  const f = fixture({ group: true, members: [me] });
  await f.performChatAction(me, chatId, "leave");
  assert.equal(f.chat.users.length, 0);
  assert.equal(f.chat.groupAdmin, null);
  assert.ok(f.chat.accountPurgeAt > Date.now() + 14 * 86400000);
  assert.equal(f.historyWrites(), 1);
});
test("non-members cannot clear, leave or change blocking", async () => {
  for (const action of ["clear", "leave", "block", "unblock", "delete-group"]) {
    const f = fixture();
    await assert.rejects(
      f.performChatAction(stranger, chatId, action),
      /Chat not found/,
    );
    assert.equal(f.preferences.size, 0);
    assert.equal(f.blocks.size, 0);
  }
});
test("block applies in both directions and unblock removes only the actor's block", async () => {
  const f = fixture();
  const blocked = await f.performChatAction(me, chatId, "block");
  assert.equal(blocked.blockedByMe, true);
  assert.equal(blocked.messagingBlocked, true);
  assert.ok(await f.directMessagingBlocked(f.chat, me));
  assert.ok(await f.directMessagingBlocked(f.chat, other));
  await f.performChatAction(other, chatId, "block");
  const result = await f.performChatAction(me, chatId, "unblock");
  assert.equal(result.blockedByMe, false);
  assert.equal(result.messagingBlocked, true);
  assert.deepEqual(f.chat.blockedBy, [other]);
  await f.performChatAction(other, chatId, "unblock");
  assert.equal(await f.directMessagingBlocked(f.chat, me), false);
});
test("shared groups are not blocked and direct chats cannot be left as groups", async () => {
  const group = fixture({ group: true });
  await assert.rejects(
    group.performChatAction(me, chatId, "block"),
    /direct chats/,
  );
  assert.equal(await group.directMessagingBlocked(group.chat, me), false);
  const direct = fixture();
  await assert.rejects(
    direct.performChatAction(me, chatId, "leave"),
    /Only groups/,
  );
});
test("history reads apply the current user's clear cutoff", async () => {
  const cutoff = new Date(),
    models = {
      Chat: { exists: async () => true },
      ChatPreference: {
        findOne: (filter) => {
          assert.equal(filter.user, me);
          return { lean: async () => ({ clearedAt: cutoff }) };
        },
      },
      Message: {
        find: (filter) => {
          assert.equal(filter.createdAt.$gt, cutoff);
          return {
            sort() {
              return this;
            },
            limit() {
              return this;
            },
            populate() {
              return this;
            },
            lean: async () => [],
          };
        },
      },
    };
  const route = load("src/app/api/messages/[chatId]/route.ts", {
    "@/lib/auth": { requireUser: async () => me },
    "@/lib/models": models,
    "@/lib/message-retention": { retainedMessageFilter: () => ({}) },
    "@/lib/realtime": {},
    "@/lib/http": {
      oid: () => true,
      json: (value) => value,
      serverError: (error) => {
        throw error;
      },
    },
  });
  const result = await route.GET(
    new Request("https://pingme.example/api/messages/" + chatId),
    { params: Promise.resolve({ chatId }) },
  );
  assert.equal(result.data.length, 0);
});
test("chat action API requires auth, same origin and a valid action", async () => {
  let authorized = true,
    origin = true,
    calls = 0;
  const route = load("src/app/api/chats/[chatId]/actions/route.ts", {
    "@/lib/auth": { requireUser: async () => (authorized ? me : null) },
    "@/lib/profile-validation": { sameOrigin: () => origin },
    "@/lib/chat-actions": {
      ChatActionError: class extends Error {},
      performChatAction: async (id, chat, action) => {
        assert.equal(id, me);
        assert.equal(chat, chatId);
        calls++;
        return { action };
      },
    },
    "@/lib/http": {
      body: (req) => req.json(),
      oid: (value) => value === chatId,
      json: (value) => Response.json(value),
      fail: (message, status = 400) => Response.json({ message }, { status }),
      serverError: (error) => {
        throw error;
      },
    },
  });
  const request = (action) =>
    route.POST(
      new Request("https://pingme.example/api/chats/" + chatId + "/actions", {
        method: "POST",
        body: JSON.stringify({ action, userId: other }),
      }),
      { params: Promise.resolve({ chatId }) },
    );
  authorized = false;
  assert.equal((await request("clear")).status, 401);
  authorized = true;
  origin = false;
  assert.equal((await request("clear")).status, 403);
  origin = true;
  assert.equal((await request("bad")).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request("clear")).status, 200);
  assert.equal(calls, 1);
});
test("blocked direct text sends are rejected before persistence", async () => {
  let writes = 0;
  const route = load("src/app/api/messages/route.ts", {
    "@/lib/auth": { requireUser: async () => me },
    "@/lib/chat-permissions": { directMessagingBlocked: async () => true },
    "@/lib/models": {
      Chat: { findOne: async () => ({ users: [me, other], isGroup: false }) },
      Message: {
        create: async () => {
          writes++;
        },
      },
    },
    "@/lib/realtime": {},
    "@/lib/http": {
      body: (req) => req.json(),
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
      body: JSON.stringify({ chatId, content: "Blocked" }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(writes, 0);
});

test("last member can permanently delete the group and all its scoped data", async () => {
  const f = fixture({ group: true, members: [me] }),
    deleted = [];
  const imageIds = ["507f1f77bcf86cd799439025", "507f1f77bcf86cd799439026"];
  f.models.Chat.deleteOne = async (filter, options) => {
    assert.equal(filter._id, chatId);
    assert.equal(filter.isGroup, true);
    assert.equal(filter.users.$size, 1);
    assert.equal(filter.users.$all[0], me);
    assert.ok(options.session);
    deleted.push("group");
    return { deletedCount: 1 };
  };
  f.models.Message.find = (filter) => {
    assert.equal(filter.chat, chatId);
    assert.equal(filter.kind, "image");
    return {
      select() {
        return this;
      },
      session() {
        return this;
      },
      lean: async () => imageIds.map((_id) => ({ _id })),
    };
  };
  f.models.ChatImage = {
    deleteMany: async (filter, options) => {
      assert.equal(filter._id.$in.join(","), imageIds.join(","));
      assert.ok(options.session);
      deleted.push("images");
    },
  };
  f.models.Message.deleteMany = async (filter, options) => {
    assert.equal(filter.chat, chatId);
    assert.ok(options.session);
    deleted.push("messages");
  };
  f.models.ChatPreference.deleteMany = async (filter, options) => {
    assert.equal(filter.chat, chatId);
    assert.ok(options.session);
    deleted.push("preferences");
  };
  const result = await f.performChatAction(me, chatId, "delete-group");
  assert.equal(result.action, "delete-group");
  assert.deepEqual(deleted, ["group", "images", "messages", "preferences"]);
  assert.equal(f.events[0][1].join(","), me);
});
test("groups with other members cannot be permanently deleted", async () => {
  const f = fixture({ group: true });
  let deleted = 0;
  f.models.Chat.deleteOne = async () => {
    deleted++;
  };
  await assert.rejects(
    f.performChatAction(me, chatId, "delete-group"),
    /last remaining member/,
  );
  assert.equal(deleted, 0);
  assert.equal(f.events.length, 0);
  const direct = fixture();
  await assert.rejects(
    direct.performChatAction(me, chatId, "delete-group"),
    /Only groups/,
  );
});
test("membership changes abort group deletion before deleting history", async () => {
  const f = fixture({ group: true, members: [me] });
  let history = 0;
  f.models.Chat.deleteOne = async () => ({ deletedCount: 0 });
  f.models.Message.find = () => {
    history++;
  };
  await assert.rejects(
    f.performChatAction(me, chatId, "delete-group"),
    /membership changed/,
  );
  assert.equal(history, 0);
  assert.equal(f.events.length, 0);
});
