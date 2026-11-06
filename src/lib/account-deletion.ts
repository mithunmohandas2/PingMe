import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import {
  Chat,
  Message,
  ProfileImage,
  User,
  ChatPreference,
  UserBlock,
} from "./models";
import { publishChatUpdate, revokeUserSessions } from "./realtime";
export const ACCOUNT_HISTORY_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
export async function deleteAccount(userId: string, passwordHash: string) {
  const deletedAt = new Date(),
    accountPurgeAt = new Date(
      deletedAt.getTime() + ACCOUNT_HISTORY_RETENTION_MS,
    );
  await ChatPreference.init();
  const session = await mongoose.startSession();
  type AffectedChat = {
    _id: unknown;
    users: unknown[];
    isGroup: boolean;
    groupAdmin?: unknown;
  };
  let affected: AffectedChat[] = [];
  try {
    await session.withTransaction(async () => {
      const deleted = await User.findOneAndUpdate(
        { _id: userId, deletedAt: null, password: passwordHash },
        {
          $set: {
            name: "Deleted account",
            email: "deleted-" + userId + "@deleted.invalid",
            password: randomBytes(48).toString("hex"),
            image: "",
            bio: "",
            deletedAt,
            accountPurgeAt,
          },
          $inc: { sessionVersion: 1 },
        },
        { new: true, session },
      );
      if (!deleted)
        throw new Error(
          "Your account changed. Please sign in again before deleting it.",
        );
      affected = await Chat.find({ users: userId })
        .select("_id users isGroup groupAdmin")
        .session(session)
        .lean<AffectedChat[]>();
      const directIds = affected
        .filter((chat) => !chat.isGroup)
        .map((chat) => chat._id);
      if (directIds.length)
        await Chat.updateMany(
          { _id: { $in: directIds } },
          { $min: { accountPurgeAt } },
          { session },
        );
      await Message.updateMany(
        { $or: [{ chat: { $in: directIds } }, { sender: userId }] },
        { $min: { accountPurgeAt } },
        { session },
      );
      await ProfileImage.deleteOne({ _id: userId }, { session });
      await ChatPreference.deleteMany({ user: userId }, { session });
      if (directIds.length)
        await ChatPreference.updateMany(
          { chat: { $in: directIds } },
          { $min: { accountPurgeAt } },
          { session },
        );
      await UserBlock.deleteMany(
        { $or: [{ blocker: userId }, { blocked: userId }] },
        { session },
      );
      await Chat.updateMany(
        { users: userId, isGroup: true },
        { $pull: { users: userId } },
        { session },
      );
      // Keep shared groups usable when their administrator deletes an account.
      for (const group of affected.filter(
        (chat) => chat.isGroup && String(chat.groupAdmin) === userId,
      )) {
        const candidates = group.users.filter((id) => String(id) !== userId);
        const next = await User.findOne({
          _id: { $in: candidates },
          deletedAt: null,
        })
          .select("_id")
          .session(session);
        await Chat.updateOne(
          { _id: group._id, groupAdmin: userId },
          { $set: { groupAdmin: next?._id || null } },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }
  await Promise.all(
    affected.map((chat) =>
      publishChatUpdate(
        String(chat._id),
        chat.users.map((id) => String(id)),
      ),
    ),
  );
  await revokeUserSessions(userId);
  return { deletedAt, accountPurgeAt };
}
