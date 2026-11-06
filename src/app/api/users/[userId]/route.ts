import { requireUser, safeUser } from "@/lib/auth";
import { User } from "@/lib/models";
import { fail, json, oid, serverError } from "@/lib/http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    if (!(await requireUser())) return fail("Unauthorized", 401);
    const { userId } = await params;
    if (!oid(userId)) return fail("Contact not found", 404);
    const user = await User.findOne({ _id: userId, deletedAt: null }).select(
      "_id name email image bio",
    );
    return user
      ? json({ data: safeUser(user) })
      : fail("Contact not found", 404);
  } catch (error) {
    return serverError(error);
  }
}
