import bcrypt from "bcryptjs";
import {
  assertAuthConfigured,
  createToken,
  requireUser,
  setSession,
} from "@/lib/auth";
import { User } from "@/lib/models";
import { body, fail, json, serverError } from "@/lib/http";
import { passwordSchema, sameOrigin } from "@/lib/profile-validation";
import { revokeUserSessions } from "@/lib/realtime";

export async function PUT(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const parsed = passwordSchema.safeParse(await body(req));
    if (!parsed.success)
      return fail(
        "Enter your current password and a new password of 8 or more characters (up to 72 bytes)",
      );
    const user = await User.findById(id);
    if (
      !user ||
      !(await bcrypt.compare(parsed.data.currentPassword, user.password))
    )
      return fail("Current password is incorrect", 400);
    if (await bcrypt.compare(parsed.data.newPassword, user.password))
      return fail("Choose a different new password");
    assertAuthConfigured();
    const token = await createToken(id, (user.sessionVersion || 0) + 1);
    const password = await bcrypt.hash(parsed.data.newPassword, 12);
    const updated = await User.findOneAndUpdate(
      { _id: id, deletedAt: null, password: user.password },
      { $set: { password }, $inc: { sessionVersion: 1 } },
      { new: true },
    );
    if (!updated)
      return fail("Your password changed. Please sign in again", 409);
    const response = json({
      data: {
        message: "Password changed. Other sessions have been signed out.",
      },
    });
    setSession(response, token);
    await revokeUserSessions(id);
    return response;
  } catch (error) {
    return serverError(error);
  }
}
