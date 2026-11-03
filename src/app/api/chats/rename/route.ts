import { requireUser } from "@/lib/auth";
import { Chat } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function PUT(req: Request) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const b = await body(req);
    if (
      !oid(b?.chatId) ||
      typeof b?.chatName !== "string" ||
      !b.chatName.trim() ||
      b.chatName.trim().length > 100
    )
      return fail("Invalid group name");
    const chat = await Chat.findOneAndUpdate(
      { _id: b.chatId, isGroup: true, groupAdmin: id },
      { $set: { chatName: b.chatName.trim() } },
      { new: true },
    )
      .populate("users", "name email image")
      .populate("groupAdmin", "name email image")
      .populate({
        path: "latestMessage",
        populate: { path: "sender", select: "name email image" },
      });
    if (chat)
      await publishChatUpdate(
        String(chat._id),
        chat.users.map((u: { _id: unknown }) => String(u._id)),
      );
    return chat
      ? json({ data: chat })
      : fail("Group not found or admin access required", 403);
  } catch (e) {
    return serverError(e);
  }
}
