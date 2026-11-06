import sharp from "sharp";
import { directMessagingBlocked } from "@/lib/chat-permissions";
import mongoose from "mongoose";
import { requireUser } from "@/lib/auth";
import { Chat, Message, ChatImage } from "@/lib/models";
import { fail, json, oid, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
import { publishChatUpdate } from "@/lib/realtime";
import { IMAGE_LIFETIME_MS } from "@/lib/image-messages";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    if (Number(req.headers.get("content-length")) > 2 * 1024 * 1024)
      return fail("Image is too large", 413);
    const form = await req.formData();
    const chatId = form.get("chatId"),
      file = form.get("image");
    if (!oid(chatId)) return fail("Invalid chat");
    const chat = await Chat.findOne({ _id: chatId, users: id });
    if (!chat) return fail("Chat not found", 404);
    if (!chat.isGroup && chat.accountPurgeAt)
      return fail("User account deleted. This conversation is read-only.", 403);
    if (await directMessagingBlocked(chat, id))
      return fail("Messaging is unavailable for this contact", 403);
    if (
      !(file instanceof File) ||
      !file.size ||
      file.size > 1024 * 1024 ||
      file.type !== "image/webp"
    )
      return fail("Upload a compressed WebP image up to 1 MB");
    let data: Buffer;
    try {
      const image = sharp(Buffer.from(await file.arrayBuffer()), {
        limitInputPixels: 16_000_000,
      });
      if ((await image.metadata()).format !== "webp")
        return fail("Invalid WebP image");
      data = await image
        .rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
    } catch {
      return fail("This image could not be read. Choose another image");
    }
    if (data.length > 1024 * 1024)
      return fail("Image is too detailed. Try a smaller crop");
    // Ensure the database TTL index exists before accepting expiring image data.
    await ChatImage.init();
    const messageId = new mongoose.Types.ObjectId(),
      sentAt = new Date();
    const expiresAt = new Date(sentAt.getTime() + IMAGE_LIFETIME_MS);
    await ChatImage.create({ _id: messageId, data, expiresAt });
    let message;
    try {
      message = await Message.create({
        _id: messageId,
        sender: id,
        chat: chatId,
        kind: "image",
        content: "Image",
        imageExpiresAt: expiresAt,
        createdAt: sentAt,
      });
    } catch (error) {
      await ChatImage.deleteOne({ _id: messageId });
      throw error;
    }
    const update = await Chat.updateOne(
      {
        _id: chatId,
        users: id,
        accountPurgeAt: null,
        ...(!chat.isGroup ? { "blockedBy.0": { $exists: false } } : {}),
      },
      { $set: { latestMessage: messageId } },
    );
    if (update?.matchedCount === 0) {
      await Message.deleteOne({ _id: messageId });
      await ChatImage.deleteOne({ _id: messageId });
      return fail("Messaging is unavailable for this conversation", 403);
    }
    await message.populate("sender", "name email image deletedAt");
    await publishChatUpdate(
      chatId,
      chat.users.map((user: unknown) => String(user)),
    );
    return json({ data: message }, 201);
  } catch (error) {
    return serverError(error);
  }
}
