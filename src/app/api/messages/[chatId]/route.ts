import { retainedMessageFilter } from "@/lib/message-retention";
import { requireUser } from "@/lib/auth";
import { Chat, Message, ChatImage, ChatPreference } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const { chatId } = await params;
    if (!oid(chatId)) return fail("Invalid chat");
    if (
      !(await Chat.exists({
        _id: chatId,
        users: id,
        $or: [
          { accountPurgeAt: null },
          { accountPurgeAt: { $gt: new Date() } },
        ],
      }))
    )
      return fail("Chat not found", 404);
    const preference = await ChatPreference.findOne({
      user: id,
      chat: chatId,
    }).lean<{ clearedAt?: Date }>();
    const messages = await Message.find({
      chat: chatId,
      ...retainedMessageFilter(),
      ...(preference?.clearedAt
        ? { createdAt: { $gt: preference.clearedAt } }
        : {}),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate("sender", "name email image deletedAt")
      .lean();
    return json({ data: messages.reverse() });
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    const userId = await requireUser();
    if (!userId) return fail("Unauthorized", 401);
    const { chatId } = await params;
    const values = await body(req);
    if (
      !oid(chatId) ||
      !Array.isArray(values?.messageIds) ||
      values.messageIds.length < 1 ||
      values.messageIds.length > 200 ||
      !values.messageIds.every(oid)
    )
      return fail("Select between 1 and 200 valid messages", 400);
    const messageIds = [...new Set<string>(values.messageIds)];
    const chat = await Chat.findOne({ _id: chatId, users: userId });
    if (!chat) return fail("Chat not found", 404);
    const filter = {
      _id: { $in: messageIds },
      chat: chatId,
      sender: userId,
      deletedAt: null,
      kind: { $ne: "group-rename" },
    };
    const owned = await Message.find(filter).select("_id").lean();
    if (owned.length !== messageIds.length)
      return fail(
        "Some messages are unavailable or do not belong to you. Please select them again.",
        409,
      );
    await Message.updateMany(
      filter,
      {
        $set: {
          content: "Message has been deleted",
          deletedAt: new Date(),
          editedAt: null,
        },
      },
      { runValidators: true },
    );
    await ChatImage.deleteMany({ _id: { $in: messageIds } });
    const messages = await Message.find({
      _id: { $in: messageIds },
      chat: chatId,
      sender: userId,
    })
      .populate("sender", "name email image deletedAt")
      .lean();
    await publishChatUpdate(
      chatId,
      chat.users.map((id: unknown) => String(id)),
    );
    return json({ data: messages });
  } catch (error) {
    return serverError(error);
  }
}
