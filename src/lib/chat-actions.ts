import mongoose from "mongoose";
import { Chat, Message, ChatPreference, UserBlock, ChatImage } from "./models";
import { blockFilter } from "./chat-permissions";
import { publishChatUpdate } from "./realtime";
export type ChatAction =
  | "clear"
  | "leave"
  | "block"
  | "unblock"
  | "delete-group";
export class ChatActionError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function performChatAction(
  userId: string,
  chatId: string,
  action: ChatAction,
) {
  const chat = await Chat.findOne({ _id: chatId, users: userId });
  if (!chat) throw new ChatActionError("Chat not found", 404);
  if (action === "clear") {
    await ChatPreference.init();
    const preference = await ChatPreference.findOneAndUpdate(
      { user: userId, chat: chatId },
      {
        $max: { clearedAt: new Date() },
        $setOnInsert: { user: userId, chat: chatId },
      },
      { upsert: true, new: true },
    );
    await publishChatUpdate(chatId, [userId]);
    return { action, clearedAt: preference.clearedAt };
  }
  if (action === "delete-group") {
    if (!chat.isGroup) throw new ChatActionError("Only groups can be deleted");
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await Chat.findOne({
          _id: chatId,
          users: userId,
          isGroup: true,
        }).session(session);
        if (
          !current ||
          current.users.length !== 1 ||
          String(current.users[0]) !== userId
        )
          throw new ChatActionError(
            "Only the last remaining member can delete this group",
            403,
          );
        // Delete the group with the same membership condition inside the transaction.
        // Concurrent membership changes conflict/retry before any history is removed.
        const removed = await Chat.deleteOne(
          { _id: chatId, isGroup: true, users: { $size: 1, $all: [userId] } },
          { session },
        );
        if (removed.deletedCount !== 1)
          throw new ChatActionError(
            "Group membership changed. Please try again.",
            409,
          );
        const images = await Message.find({ chat: chatId, kind: "image" })
          .select("_id")
          .session(session)
          .lean<{ _id: unknown }[]>();
        if (images.length)
          await ChatImage.deleteMany(
            { _id: { $in: images.map((message) => message._id) } },
            { session },
          );
        await Message.deleteMany({ chat: chatId }, { session });
        await ChatPreference.deleteMany({ chat: chatId }, { session });
      });
    } finally {
      await session.endSession();
    }
    await publishChatUpdate(chatId, [userId]);
    return { action };
  }
  if (action === "leave") {
    if (!chat.isGroup) throw new ChatActionError("Only groups can be left");
    await ChatPreference.init();
    const session = await mongoose.startSession();
    let recipients: string[] = [];
    try {
      await session.withTransaction(async () => {
        const current = await Chat.findOne({
          _id: chatId,
          users: userId,
          isGroup: true,
        }).session(session);
        if (!current)
          throw new ChatActionError(
            "You are no longer a member of this group",
            403,
          );
        recipients = current.users.map((id: unknown) => String(id));
        const remaining = current.users.filter(
          (id: unknown) => String(id) !== userId,
        );
        const changes: Record<string, unknown> = {};
        if (String(current.groupAdmin) === userId)
          changes.groupAdmin = remaining[0] || null;
        if (!remaining.length)
          changes.accountPurgeAt = new Date(Date.now() + 15 * 86400000);
        await Chat.updateOne(
          { _id: chatId, users: userId },
          { $pull: { users: userId }, $set: changes },
          { session },
        );
        if (!remaining.length) {
          await Message.updateMany(
            { chat: chatId },
            { $min: { accountPurgeAt: changes.accountPurgeAt } },
            { session },
          );
          await ChatPreference.updateMany(
            { chat: chatId },
            { $min: { accountPurgeAt: changes.accountPurgeAt } },
            { session },
          );
        }
      });
    } finally {
      await session.endSession();
    }
    await publishChatUpdate(chatId, recipients);
    return { action };
  }
  if (chat.isGroup)
    throw new ChatActionError(
      "Blocking applies to direct chats, not shared groups",
    );
  const other = chat.users.find((id: unknown) => String(id) !== userId);
  if (!other) throw new ChatActionError("Contact not found", 404);
  const otherId = String(other);
  await UserBlock.init();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (action === "block")
        await UserBlock.updateOne(
          { blocker: userId, blocked: otherId },
          { $setOnInsert: { blocker: userId, blocked: otherId } },
          { upsert: true, session },
        );
      else
        await UserBlock.deleteOne(
          { blocker: userId, blocked: otherId },
          { session },
        );
      await Chat.updateMany(
        { isGroup: false, users: { $all: [userId, otherId] } },
        action === "block"
          ? { $addToSet: { blockedBy: userId } }
          : { $pull: { blockedBy: userId } },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  const messagingBlocked = !!(await UserBlock.exists(
    blockFilter(userId, otherId),
  ));
  await publishChatUpdate(
    chatId,
    chat.users.map((id: unknown) => String(id)),
  );
  return { action, blockedByMe: action === "block", messagingBlocked };
}
