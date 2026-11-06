import { requireUser } from "@/lib/auth";
import { Chat, ChatImage, Message, ChatPreference } from "@/lib/models";
import { fail, oid, serverError } from "@/lib/http";
import { imageExpired } from "@/lib/image-messages";
export const runtime = "nodejs";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  try {
    const userId = await requireUser();
    if (!userId) return fail("Unauthorized", 401);
    const { messageId } = await params;
    if (!oid(messageId)) return fail("Invalid image");
    const message = await Message.findById(messageId).lean<{
      kind?: string;
      chat: string;
      deletedAt?: Date;
      createdAt: Date;
      imageExpiresAt: Date;
    }>();
    if (
      !message ||
      message.kind !== "image" ||
      !(await Chat.exists({ _id: message.chat, users: userId }))
    )
      return fail("Image not found", 404);
    const preference = await ChatPreference.findOne({
      user: userId,
      chat: message.chat,
    }).lean<{ clearedAt?: Date }>();
    if (
      preference?.clearedAt &&
      new Date(message.createdAt).getTime() <= preference.clearedAt.getTime()
    )
      return fail("Image not found", 404);
    if (message.deletedAt || imageExpired(message)) {
      await ChatImage.deleteOne({ _id: messageId });
      return fail(
        message.deletedAt ? "Message has been deleted" : "Image auto deleted",
        410,
      );
    }
    const image = await ChatImage.findOne({
      _id: messageId,
      expiresAt: { $gt: new Date() },
    });
    if (!image) return fail("Image auto deleted", 410);
    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
