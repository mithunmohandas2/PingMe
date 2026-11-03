import bcrypt from "bcryptjs";
import { requireUser, safeUser } from "@/lib/auth";
import { User } from "@/lib/models";
import { body, fail, json, serverError } from "@/lib/http";
import { profileSchema, sameOrigin } from "@/lib/profile-validation";
import { notifyProfileUpdate } from "@/lib/profile-updates";

export async function PATCH(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const parsed = profileSchema.safeParse(await body(req));
    if (!parsed.success)
      return fail("Enter a valid name, email and bio (up to 160 characters)");
    const user = await User.findById(id);
    if (!user) return fail("Unauthorized", 401);
    const { name, email, bio, currentPassword } = parsed.data;
    if (
      email !== user.email &&
      (!currentPassword ||
        !(await bcrypt.compare(currentPassword, user.password)))
    ) {
      return fail("Enter your current password to change your email", 400);
    }
    const updated = await User.findOneAndUpdate(
      { _id: id, password: user.password },
      { $set: { name, email, bio } },
      { new: true, runValidators: true },
    );
    if (updated) await notifyProfileUpdate(id);
    return updated
      ? json({ data: safeUser(updated) })
      : fail("Your account changed. Please sign in again", 409);
  } catch (error: unknown) {
    if ((error as { code?: number })?.code === 11000)
      return fail("Email is already registered", 409);
    return serverError(error);
  }
}
