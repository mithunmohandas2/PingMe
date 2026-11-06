import { requireUser } from "@/lib/auth";
import { retainedMessageFilter } from "@/lib/message-retention";
import { Chat, User, Message, ChatPreference, UserBlock } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { blockFilter } from "@/lib/chat-permissions";
import { publishChatUpdate } from "@/lib/realtime";
export async function GET() {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const chats = await Chat.find({
      users: id,
      $or: [{ accountPurgeAt: null }, { accountPurgeAt: { $gt: new Date() } }],
    })
      .populate("users", "name email image deletedAt")
      .populate("groupAdmin", "name email image deletedAt")
      .populate({
        path: "latestMessage",
        match: retainedMessageFilter(),
        populate: { path: "sender", select: "name email image deletedAt" },
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    const preferences = await ChatPreference.find({
      user: id,
      chat: { $in: chats.map((chat) => chat._id) },
    })
      .select("chat clearedAt")
      .lean();
    const clears = new Map(
      preferences.map((value) => [String(value.chat), value.clearedAt]),
    );
    for (const chat of chats) {
      const clearedAt = clears.get(String(chat._id));
      Object.assign(chat, {
        clearedAt: clearedAt || null,
        blockedByMe: (chat.blockedBy || []).some(
          (value: unknown) => String(value) === id,
        ),
        messagingBlocked: !chat.isGroup && !!chat.blockedBy?.length,
      });
      delete chat.blockedBy;
      if (
        clearedAt &&
        chat.latestMessage &&
        new Date(chat.latestMessage.createdAt).getTime() <=
          new Date(clearedAt).getTime()
      )
        chat.latestMessage = null;
    }
    const missing = chats.filter((chat) => !chat.latestMessage);
    if (missing.length) {
      // A TTL deletion leaves the chat's old reference behind. Resolve all missing
      // previews in one query, rather than one request/query per conversation.
      const latest = await Message.aggregate([
        {
          $match: {
            chat: { $in: missing.map((chat) => chat._id) },
            ...retainedMessageFilter(),
            $or: missing.map((chat) => ({
              chat: chat._id,
              ...(clears.get(String(chat._id))
                ? { createdAt: { $gt: clears.get(String(chat._id)) } }
                : {}),
            })),
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        { $group: { _id: "$chat", message: { $first: "$$ROOT" } } },
      ]);
      await Message.populate(latest, {
        path: "message.sender",
        select: "name email image deletedAt",
      });
      const byChat = new Map(
        latest.map((item) => [String(item._id), item.message]),
      );
      for (const chat of missing)
        chat.latestMessage = byChat.get(String(chat._id)) || null;
    }
    return json({ data: chats });
  } catch (e) {
    return serverError(e);
  }
}
export async function POST(req: Request) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const b = await body(req);
    if (!oid(b?.userId) || b.userId === id) return fail("Invalid recipient");
    if (!(await User.exists({ _id: b.userId, deletedAt: null })))
      return fail("Recipient not found", 404);
    if (await UserBlock.exists(blockFilter(id, b.userId)))
      return fail("Messaging is unavailable for this contact", 403);
    let chat = await Chat.findOne({
      isGroup: false,
      users: { $all: [id, b.userId], $size: 2 },
    });
    const created = !chat;
    if (!chat)
      chat = await Chat.create({
        chatName: "",
        isGroup: false,
        users: [id, b.userId],
      });
    await chat.populate("users", "name email image deletedAt");
    await chat.populate({
      path: "latestMessage",
      match: retainedMessageFilter(),
      populate: { path: "sender", select: "name email image deletedAt" },
    });
    const preference = await ChatPreference.findOne({
      user: id,
      chat: chat._id,
    }).lean<{ clearedAt?: Date }>();
    const result = chat.toObject();
    result.clearedAt = preference?.clearedAt || null;
    result.blockedByMe = (chat.blockedBy || []).some(
      (value: unknown) => String(value) === id,
    );
    result.messagingBlocked = !!chat.blockedBy?.length;
    delete result.blockedBy;
    if (
      preference?.clearedAt &&
      result.latestMessage &&
      new Date(result.latestMessage.createdAt).getTime() <=
        preference.clearedAt.getTime()
    )
      result.latestMessage = null;
    if (created) await publishChatUpdate(String(chat._id), [id, b.userId]);
    return json({ data: result });
  } catch (e) {
    return serverError(e);
  }
}
