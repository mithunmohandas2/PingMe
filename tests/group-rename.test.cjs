const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
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
    Buffer,
  });
  return module.exports;
}
const userId = "507f1f77bcf86cd799439011",
  otherId = "507f1f77bcf86cd799439012",
  chatId = "507f1f77bcf86cd799439020";
function fixture({
  allowed = true,
  failCreate = false,
  failSave = false,
} = {}) {
  let name = "Original group",
    latestId = null,
    ended = 0;
  const messages = [],
    events = [];
  const session = {
    withTransaction: async (action) => {
      const previous = { name, latestId, count: messages.length };
      try {
        await action();
      } catch (error) {
        name = previous.name;
        latestId = previous.latestId;
        messages.splice(previous.count);
        throw error;
      }
    },
    endSession: async () => {
      ended++;
    },
  };
  const chat = {
    get chatName() {
      return name;
    },
    set chatName(value) {
      name = value;
    },
    get latestMessage() {
      return latestId;
    },
    set latestMessage(value) {
      latestId = value;
    },
    save: async (options) => {
      assert.equal(options.session, session);
      if (failSave) throw Error("Save failed");
    },
    populate: async () => chat,
    toObject: () => ({
      _id: chatId,
      chatName: name,
      isGroup: true,
      users: [{ _id: userId }, { _id: otherId }],
      latestMessage: messages.find((message) => message._id === latestId),
    }),
  };
  const models = {
    Chat: {
      findOne: (filter) => {
        assert.equal(filter._id, chatId);
        assert.equal(filter.isGroup, true);
        assert.equal(filter.groupAdmin, userId);
        assert.equal(filter.users, userId);
        return {
          session: async (value) => {
            assert.equal(value, session);
            return allowed ? chat : null;
          },
        };
      },
    },
    Message: {
      create: async (values, options) => {
        assert.equal(options.session, session);
        if (failCreate) throw Error("Message failed");
        const message = {
          ...values[0],
          _id: "event-" + (messages.length + 1),
          sender: { _id: values[0].sender },
          createdAt: new Date().toISOString(),
        };
        messages.push(message);
        return [message];
      },
    },
  };
  const service = load("src/lib/group-rename.ts", {
    mongoose: { startSession: async () => session },
    "./models": models,
    "./realtime": { publishChatUpdate: async (...event) => events.push(event) },
  });
  return { ...service, messages, events, name: () => name, ended: () => ended };
}
test("renaming a group atomically creates the attributed activity message", async () => {
  const f = fixture();
  const result = await f.renameGroupWithMessage(
    userId,
    chatId,
    "  New group  ",
  );
  assert.equal(result.chatName, "New group");
  assert.equal(f.messages.length, 1);
  assert.equal(
    result.activityMessage.content,
    "Changed the group name from Original group to New group",
  );
  assert.equal(result.activityMessage.kind, "group-rename");
  assert.equal(result.activityMessage.sender._id, userId);
  assert.equal(result.latestMessage._id, result.activityMessage._id);
  assert.equal(f.events[0][1].join(","), [userId, otherId].join(","));
  assert.equal(f.ended(), 1);
});
test("unchanged names create no duplicate messages or notifications", async () => {
  const f = fixture();
  const result = await f.renameGroupWithMessage(
    userId,
    chatId,
    " Original group ",
  );
  assert.equal(result.activityMessage, undefined);
  assert.equal(f.messages.length, 0);
  assert.equal(f.events.length, 0);
});
test("subsequent renames use the current previous name", async () => {
  const f = fixture();
  await f.renameGroupWithMessage(userId, chatId, "Middle");
  const next = await f.renameGroupWithMessage(userId, chatId, "Final");
  assert.equal(
    next.activityMessage.content,
    "Changed the group name from Middle to Final",
  );
  assert.equal(f.messages.length, 2);
});
test("failed message creation or rename save leaves no partial change", async () => {
  for (const options of [{ failCreate: true }, { failSave: true }]) {
    const f = fixture(options);
    await assert.rejects(f.renameGroupWithMessage(userId, chatId, "New"));
    assert.equal(f.name(), "Original group");
    assert.equal(f.messages.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.ended(), 1);
  }
});
test("only a current group admin may rename and invalid names are rejected", async () => {
  const f = fixture({ allowed: false });
  await assert.rejects(
    f.renameGroupWithMessage(userId, chatId, "New"),
    /admin access/,
  );
  assert.equal(f.messages.length, 0);
  const valid = fixture();
  for (const name of ["   ", "x".repeat(101)])
    await assert.rejects(
      valid.renameGroupWithMessage(userId, chatId, name),
      /Invalid group name/,
    );
});
test("rename API authenticates, validates origin, and ignores spoofed senders", async () => {
  let user = userId,
    origin = true,
    calls = 0;
  const route = load("src/app/api/chats/rename/route.ts", {
    "@/lib/auth": { requireUser: async () => user },
    "@/lib/profile-validation": { sameOrigin: () => origin },
    "@/lib/group-rename": {
      GroupRenameError: class extends Error {},
      renameGroupWithMessage: async (id, chat, name) => {
        assert.equal(id, userId);
        assert.equal(chat, chatId);
        calls++;
        return { chatName: name };
      },
    },
    "@/lib/http": {
      body: (request) => request.json(),
      oid: (value) => value === chatId,
      json: (value) => Response.json(value),
      fail: (message, status = 400) => Response.json({ message }, { status }),
      serverError: (error) => {
        throw error;
      },
    },
  });
  const invoke = (chatName = "New") =>
    route.PUT(
      new Request("https://pingme.example/api/chats/rename", {
        method: "PUT",
        body: JSON.stringify({ chatId, chatName, sender: otherId }),
      }),
    );
  user = null;
  assert.equal((await invoke()).status, 401);
  user = userId;
  origin = false;
  assert.equal((await invoke()).status, 403);
  origin = true;
  assert.equal((await invoke("")).status, 400);
  assert.equal(calls, 0);
  assert.equal((await invoke()).status, 200);
  assert.equal(calls, 1);
});

test("message schema accepts automatic group rename activity", () => {
  const policy = load("src/lib/message-retention.ts");
  const { Message } = load("src/lib/models.ts", {
    "./message-retention": policy,
  });
  const message = new Message({
    sender: userId,
    chat: chatId,
    kind: "group-rename",
    content: "Changed the group name from Old to New",
  });
  assert.equal(message.validateSync(), undefined);
});
