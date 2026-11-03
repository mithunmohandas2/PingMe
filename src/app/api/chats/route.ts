import { requireUser } from "@/lib/auth";
import { Chat, User } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function GET() {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const chats = await Chat.find({ users: id })
      .populate("users", "name email image")
      .populate("groupAdmin", "name email image")
      .populate({
        path: "latestMessage",
        populate: { path: "sender", select: "name email image" },
      })
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    return json({ data: chats });
  } catch (e) {
    return serverError(e);
  }
}
export async function POST(req: Request) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const b = await body(req);
    if (!oid(b?.userId) || b.userId === id) return fail("Invalid recipient");
    if (!(await User.exists({ _id: b.userId })))
      return fail("Recipient not found", 404);
    let chat = await Chat.findOne({
      isGroup: false,
      users: { $all: [id, b.userId], $size: 2 },
    });
    const created = !chat;
    if (!chat)
      chat = await Chat.create({
        chatName: "",
        isGroup: false,
        users: [id, b.userId],
      });
    await chat.populate("users", "name email image");
    await chat.populate({
      path: "latestMessage",
      populate: { path: "sender", select: "name email image" },
    });
    if (created) await publishChatUpdate(String(chat._id), [id, b.userId]);
    return json({ data: chat });
  } catch (e) {
    return serverError(e);
  }
}
