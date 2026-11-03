import { requireUser } from "@/lib/auth";
import { Chat, User } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function POST(req: Request) {
  try {
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const b = await body(req);
    const name = typeof b?.name === "string" ? b.name.trim() : "";
    let users = b?.users;
    if (typeof users === "string") {
      try {
        users = JSON.parse(users);
      } catch {
        return fail("Invalid members");
      }
    }
    if (
      !name ||
      name.length > 100 ||
      !Array.isArray(users) ||
      users.length < 2 ||
      users.length > 49 ||
      !users.every(oid)
    )
      return fail("A group needs a name and at least two other members");
    const members = [...new Set([...users, id])];
    if (members.length < 3) return fail("Select two distinct members");
    if (
      (await User.countDocuments({ _id: { $in: members } })) !== members.length
    )
      return fail("Unknown user");
    const chat = await Chat.create({
      chatName: name,
      isGroup: true,
      users: members,
      groupAdmin: id,
    });
    await chat.populate("users", "name email image");
    await chat.populate("groupAdmin", "name email image");
    await publishChatUpdate(String(chat._id), members);
    return json({ data: chat }, 201);
  } catch (e) {
    return serverError(e);
  }
}
