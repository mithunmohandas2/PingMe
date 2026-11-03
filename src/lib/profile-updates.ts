import { Chat } from "./models";
import { publishChatUpdate } from "./realtime";

export async function notifyProfileUpdate(userId: string) {
  if (!process.env.REDIS_URL) return;
  const chats = await Chat.find({ users: userId })
    .select("_id users")
    .limit(100)
    .lean();
  await Promise.all(
    chats.map((chat) =>
      publishChatUpdate(
        String(chat._id),
        chat.users.map((id: unknown) => String(id)),
      ),
    ),
  );
}
