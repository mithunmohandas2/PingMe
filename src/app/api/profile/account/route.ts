import bcrypt from "bcryptjs";
import { requireUser, cookieName } from "@/lib/auth";
import { User } from "@/lib/models";
import { deleteAccount } from "@/lib/account-deletion";
import { body, fail, json, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
export async function DELETE(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const values = await body(req);
    if (
      values?.confirmation !== "DELETE" ||
      typeof values?.currentPassword !== "string" ||
      !values.currentPassword ||
      values.currentPassword.length > 128
    )
      return fail("Confirm deletion and enter your current password");
    const user = await User.findOne({ _id: id, deletedAt: null });
    if (!user || !(await bcrypt.compare(values.currentPassword, user.password)))
      return fail("Current password is incorrect");
    const result = await deleteAccount(id, user.password);
    const response = json({
      data: {
        message: "Your account has been deleted.",
        accountPurgeAt: result.accountPurgeAt,
      },
    });
    response.cookies.set(cookieName, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return serverError(error);
  }
}
