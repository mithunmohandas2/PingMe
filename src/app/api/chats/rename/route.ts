import { requireUser } from "@/lib/auth";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
import { GroupRenameError, renameGroupWithMessage } from "@/lib/group-rename";
export async function PUT(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const values = await body(req);
    if (
      !oid(values?.chatId) ||
      typeof values?.chatName !== "string" ||
      !values.chatName.trim() ||
      values.chatName.trim().length > 100
    )
      return fail("Invalid group name");
    return json({
      data: await renameGroupWithMessage(id, values.chatId, values.chatName),
    });
  } catch (error) {
    return error instanceof GroupRenameError
      ? fail(error.message, error.status)
      : serverError(error);
  }
}
