import { directMessagingBlocked } from "@/lib/chat-permissions";
import { requireUser } from "@/lib/auth";
import { Chat, Message, ChatImage } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";

type Context = { params: Promise<{ chatId: string; messageId: string }> };
async function change(req: Request, context: Context, deleting: boolean) {
  try {
    const userId = await requireUser();
    if (!userId) return fail("Unauthorized", 401);
    const { chatId, messageId } = await context.params;
    if (!oid(chatId) || !oid(messageId)) return fail("Invalid message", 400);
    const chat = await Chat.findOne({ _id: chatId, users: userId });
    if (!chat) return fail("Chat not found", 404);
    if (!deleting && (await directMessagingBlocked(chat, userId)))
      return fail("Messaging is unavailable for this contact", 403);
    let content = "Message has been deleted";
    if (!deleting) {
      const values = await body(req);
      if (
        typeof values?.content !== "string" ||
        !values.content.trim() ||
        values.content.trim().length > 4000
      )
        return fail("Message must contain between 1 and 4000 characters", 400);
      content = values.content.trim();
    }
    // Atomic ownership and deletion checks prevent edits from restoring deleted messages.
    const message = await Message.findOneAndUpdate(
      {
        _id: messageId,
        chat: chatId,
        sender: userId,
        deletedAt: null,
        kind: deleting
          ? { $ne: "group-rename" }
          : { $nin: ["image", "group-rename"] },
      },
      {
        $set: deleting
          ? { content, deletedAt: new Date(), editedAt: null }
          : { content, editedAt: new Date() },
      },
      { new: true, runValidators: true },
    ).populate("sender", "name email image deletedAt");
    if (!message) return fail("Message not found or already deleted", 404);
    if (deleting) await ChatImage.deleteOne({ _id: messageId });
    await publishChatUpdate(
      chatId,
      chat.users.map((id: unknown) => String(id)),
    );
    return json({ data: message });
  } catch (error) {
    return serverError(error);
  }
}
export function PATCH(req: Request, context: Context) {
  return change(req, context, false);
}
export function DELETE(req: Request, context: Context) {
  return change(req, context, true);
}
