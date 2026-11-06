import mongoose from "mongoose";
import { Chat, Message } from "./models";
import { publishChatUpdate } from "./realtime";
export class GroupRenameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function renameGroupWithMessage(
  userId: string,
  chatId: string,
  name: string,
) {
  const nextName = name.trim();
  if (!nextName || nextName.length > 100)
    throw new GroupRenameError("Invalid group name");
  const session = await mongoose.startSession();
  let result: any,
    changed = false;
  try {
    await session.withTransaction(async () => {
      changed = false;
      const chat = await Chat.findOne({
        _id: chatId,
        isGroup: true,
        groupAdmin: userId,
        users: userId,
      }).session(session);
      if (!chat)
        throw new GroupRenameError(
          "Group not found or admin access required",
          403,
        );
      const previousName = chat.chatName;
      if (previousName !== nextName) {
        const [message] = await Message.create(
          [
            {
              sender: userId,
              chat: chatId,
              kind: "group-rename",
              content:
                "Changed the group name from " +
                previousName +
                " to " +
                nextName,
            },
          ],
          { session },
        );
        chat.chatName = nextName;
        chat.latestMessage = message._id;
        await chat.save({ session });
        changed = true;
      }
      // Keep the rename and its automatic message in the same transaction.
      await chat.populate("users", "name email image deletedAt");
      await chat.populate("groupAdmin", "name email image deletedAt");
      await chat.populate({
        path: "latestMessage",
        populate: { path: "sender", select: "name email image deletedAt" },
      });
      result = chat.toObject();
      if (changed) result.activityMessage = result.latestMessage;
    });
  } finally {
    await session.endSession();
  }
  if (changed)
    await publishChatUpdate(
      chatId,
      result.users.map((user: { _id: unknown }) => String(user._id)),
    );
  return result;
}
