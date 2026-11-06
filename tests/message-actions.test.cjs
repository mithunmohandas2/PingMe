const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const owner = "507f1f77bcf86cd799439011",
  other = "507f1f77bcf86cd799439012";
const chatId = "507f1f77bcf86cd799439020",
  messageId = "507f1f77bcf86cd799439021";
function fixture({
  user = owner,
  member = true,
  sender = owner,
  deleted = false,
  blocked = false,
  kind = "text",
} = {}) {
  const message = {
    _id: messageId,
    chat: chatId,
    sender,
    content: "Original message",
    kind,
    deletedAt: deleted ? new Date() : null,
  };
  const events = [];
  let writes = 0;
  const stubs = {
    "@/lib/chat-permissions": { directMessagingBlocked: async () => blocked },
    "@/lib/message-retention": { retainedMessageFilter: () => ({}) },
    "@/lib/auth": { requireUser: async () => user },
    "@/lib/http": {
      body: (req) => req.json().catch(() => null),
      oid: (value) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value),
      fail: (message, status = 400) => Response.json({ message }, { status }),
      json: (value) => Response.json(value),
      serverError: (error) => {
        throw error;
      },
    },
    "@/lib/models": {
      ChatImage: { deleteOne: async () => {}, deleteMany: async () => {} },
      Chat: {
        findOne: async (filter) => {
          assert.equal(filter.users, user);
          return member && filter._id === chatId
            ? { users: [owner, other] }
            : null;
        },
      },
      Message: {
        findOneAndUpdate: (filter, update, options) => ({
          populate: async () => {
            assert.equal(filter.deletedAt, null);
            assert.equal(options.new, true);
            assert.equal(options.runValidators, true);
            if (
              filter._id !== messageId ||
              filter.chat !== message.chat ||
              filter.sender !== message.sender ||
              message.deletedAt ||
              (filter.kind?.$ne && message.kind === filter.kind.$ne) ||
              filter.kind?.$nin?.includes(message.kind)
            )
              return null;
            writes++;
            Object.assign(message, update.$set);
            return { ...message, sender: { _id: sender, name: "Sender" } };
          },
        }),
      },
    },
    "@/lib/realtime": {
      publishChatUpdate: async (...args) => events.push(args),
    },
  };
  const module = { exports: {} };
  const file = "src/app/api/messages/[chatId]/[messageId]/route.ts";
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => stubs[name],
    Date,
  });
  const invoke = (method, content, params = { chatId, messageId }) =>
    module.exports[method](
      new Request(
        "https://pingme.example/api/messages/" + chatId + "/" + messageId,
        {
          method,
          ...(content === undefined
            ? {}
            : {
                body: JSON.stringify({ content }),
                headers: { "Content-Type": "application/json" },
              }),
        },
      ),
      { params: Promise.resolve(params) },
    );
  return { invoke, message, events, writes: () => writes };
}
test("owner can edit, trims content, marks edited and notifies all chat members", async () => {
  const f = fixture();
  const res = await f.invoke("PATCH", "  Revised message  ");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.content, "Revised message");
  assert.ok(data.editedAt);
  assert.equal(data.deletedAt, null);
  assert.equal(f.events[0][0], chatId);
  assert.equal(f.events[0][1].join(","), [owner, other].join(","));
});
test("delete clears saved original content and cannot be edited or deleted again", async () => {
  const f = fixture();
  assert.equal((await f.invoke("DELETE")).status, 200);
  assert.equal(f.message.content, "Message has been deleted");
  assert.ok(f.message.deletedAt);
  assert.equal(f.message.editedAt, null);
  assert.equal((await f.invoke("PATCH", "Resurrect")).status, 404);
  assert.equal((await f.invoke("DELETE")).status, 404);
  assert.equal(f.writes(), 1);
});
for (const method of ["PATCH", "DELETE"]) {
  test(method + " rejects unauthenticated requests", async () => {
    const f = fixture({ user: null });
    assert.equal((await f.invoke(method, "Changed")).status, 401);
    assert.equal(f.writes(), 0);
  });
  test(method + " rejects non-members and other senders", async () => {
    for (const options of [{ member: false }, { user: other }]) {
      const f = fixture(options);
      assert.equal((await f.invoke(method, "Changed")).status, 404);
      assert.equal(f.writes(), 0);
      assert.equal(f.events.length, 0);
    }
  });
  test(
    method + " rejects invalid IDs and messages in a different chat",
    async () => {
      const f = fixture();
      assert.equal(
        (await f.invoke(method, "Changed", { chatId, messageId: "bad" }))
          .status,
        400,
      );
      assert.equal(
        (await f.invoke(method, "Changed", { chatId: other, messageId }))
          .status,
        404,
      );
      assert.equal(f.writes(), 0);
    },
  );
}
test("editing rejects empty, non-text and oversized content", async () => {
  const f = fixture();
  for (const content of ["", "   ", "x".repeat(4001), 123, null])
    assert.equal((await f.invoke("PATCH", content)).status, 400);
  assert.equal(f.writes(), 0);
});

function bulkFixture({
  user = owner,
  member = true,
  unavailable = false,
  immutable = false,
} = {}) {
  const ids = [messageId, "507f1f77bcf86cd799439022"];
  const messages = ids.map((_id) => ({
    _id,
    sender: owner,
    chat: chatId,
    content: "Original",
    kind: immutable && _id === ids[1] ? "group-rename" : "text",
    deletedAt: null,
  }));
  let writes = 0,
    events = 0;
  const http = {
    body: (req) => req.json().catch(() => null),
    oid: (value) => typeof value === "string" && /^[a-f0-9]{24}$/.test(value),
    fail: (message, status = 400) => Response.json({ message }, { status }),
    json: (data) => Response.json(data),
    serverError: (error) => {
      throw error;
    },
  };
  const stubs = {
    "@/lib/message-retention": { retainedMessageFilter: () => ({}) },
    "@/lib/auth": { requireUser: async () => user },
    "@/lib/http": http,
    "@/lib/realtime": {
      publishChatUpdate: async () => {
        events++;
      },
    },
    "@/lib/models": {
      ChatImage: { deleteOne: async () => {}, deleteMany: async () => {} },
      Chat: {
        findOne: async () => (member ? { users: [owner, other] } : null),
      },
      Message: {
        find: (filter) => {
          assert.equal(filter.sender, user);
          assert.equal(filter.chat, chatId);
          let matching = messages.filter(
            (message) =>
              filter._id.$in.includes(message._id) &&
              message.sender === user &&
              (!filter.kind?.$ne || message.kind !== filter.kind.$ne),
          );
          if (filter.deletedAt === null && unavailable)
            matching = matching.slice(0, 1);
          return {
            select: () => ({ lean: async () => matching }),
            populate: () => ({ lean: async () => matching }),
          };
        },
        updateMany: async (filter, update) => {
          assert.equal(filter.sender, user);
          assert.equal(filter.chat, chatId);
          assert.equal(filter.deletedAt, null);
          writes++;
          for (const message of messages)
            if (filter._id.$in.includes(message._id))
              Object.assign(message, update.$set);
        },
      },
    },
  };
  const module = { exports: {} };
  const source = ts.transpileModule(
    fs.readFileSync("src/app/api/messages/[chatId]/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    },
  ).outputText;
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require: (name) => stubs[name],
    Date,
    Set,
  });
  const invoke = (messageIds = ids) =>
    module.exports.DELETE(
      new Request("https://pingme.example/api/messages/" + chatId, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIds }),
      }),
      { params: Promise.resolve({ chatId }) },
    );
  return { invoke, messages, ids, writes: () => writes, events: () => events };
}
test("bulk deletion removes multiple owned messages with one write and one notification", async () => {
  const f = bulkFixture();
  const response = await f.invoke();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.length, 2);
  assert.equal(f.writes(), 1);
  assert.equal(f.events(), 1);
  assert.ok(
    f.messages.every(
      (message) =>
        message.deletedAt && message.content === "Message has been deleted",
    ),
  );
});
test("bulk deletion rejects mixed ownership or unavailable messages without partial deletion", async () => {
  for (const options of [{ unavailable: true }, { user: other }]) {
    const f = bulkFixture(options);
    assert.equal((await f.invoke()).status, 409);
    assert.equal(f.writes(), 0);
    assert.equal(f.events(), 0);
    assert.ok(f.messages.every((message) => !message.deletedAt));
  }
});
test("bulk deletion authenticates users and checks chat membership", async () => {
  for (const [options, status] of [
    [{ user: null }, 401],
    [{ member: false }, 404],
  ]) {
    const f = bulkFixture(options);
    assert.equal((await f.invoke()).status, status);
    assert.equal(f.writes(), 0);
  }
});
test("bulk deletion rejects invalid or excessive selections", async () => {
  const f = bulkFixture();
  for (const value of [[], ["bad"], null, "bad", Array(201).fill(messageId)])
    assert.equal((await f.invoke(value)).status, 400);
  assert.equal(f.writes(), 0);
});
test("bulk deletion deduplicates message IDs", async () => {
  const f = bulkFixture();
  assert.equal((await f.invoke([f.ids[0], f.ids[0]])).status, 200);
  assert.ok(f.messages[0].deletedAt);
  assert.equal(f.messages[1].deletedAt, null);
});

test("blocking prevents edits from bypassing direct-message restrictions", async () => {
  const f = fixture({ blocked: true });
  assert.equal((await f.invoke("PATCH", "Bypass attempt")).status, 403);
  assert.equal(f.writes(), 0);
  assert.equal((await f.invoke("DELETE")).status, 200);
});

test("automatic group-rename messages cannot be edited or deleted", async () => {
  const f = fixture({ kind: "group-rename" });
  assert.equal((await f.invoke("PATCH", "Rewrite activity")).status, 404);
  assert.equal((await f.invoke("DELETE")).status, 404);
  assert.equal(f.writes(), 0);
});

test("bulk deletion rejects automatic activity without deleting other selected messages", async () => {
  const f = bulkFixture({ immutable: true });
  assert.equal((await f.invoke()).status, 409);
  assert.equal(f.writes(), 0);
  assert.ok(f.messages.every((message) => !message.deletedAt));
  assert.equal((await f.invoke([f.ids[0]])).status, 200);
  assert.equal(f.messages[1].deletedAt, null);
});
