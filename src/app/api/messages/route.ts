import { directMessagingBlocked } from "@/lib/chat-permissions";
import { requireUser } from "@/lib/auth";
import { Chat, Message } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function POST(req: Request) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const b = await body(req);
    if (
      !oid(b?.chatId) ||
      typeof b?.content !== "string" ||
      !b.content.trim() ||
      b.content.trim().length > 4000
    )
      return fail("Invalid message");
    const chat = await Chat.findOne({ _id: b.chatId, users: id });
    if (!chat) return fail("Chat not found", 404);
    if (!chat.isGroup && chat.accountPurgeAt)
      return fail("User account deleted. This conversation is read-only.", 403);
    if (await directMessagingBlocked(chat, id))
      return fail("Messaging is unavailable for this contact", 403);
    const msg = await Message.create({
      sender: id,
      content: b.content.trim(),
      chat: chat._id,
    });
    const update = await Chat.updateOne(
      {
        _id: chat._id,
        users: id,
        accountPurgeAt: null,
        ...(!chat.isGroup ? { "blockedBy.0": { $exists: false } } : {}),
      },
      { $set: { latestMessage: msg._id } },
    );
    if (update?.matchedCount === 0) {
      await Message.deleteOne({ _id: msg._id });
      return fail("Messaging is unavailable for this conversation", 403);
    }
    await msg.populate("sender", "name email image deletedAt");
    await publishChatUpdate(
      String(chat._id),
      chat.users.map((u: unknown) => String(u)),
    );
    return json({ data: msg }, 201);
  } catch (e) {
    return serverError(e);
  }
}
