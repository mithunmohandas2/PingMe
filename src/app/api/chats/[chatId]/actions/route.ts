import { requireUser } from "@/lib/auth";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
import {
  ChatActionError,
  performChatAction,
  type ChatAction,
} from "@/lib/chat-actions";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ chatId: string }> },
) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    const { chatId } = await params,
      values = await body(req);
    if (
      !oid(chatId) ||
      !["clear", "leave", "block", "unblock", "delete-group"].includes(
        values?.action,
      )
    )
      return fail("Invalid chat action");
    return json({
      data: await performChatAction(id, chatId, values.action as ChatAction),
    });
  } catch (error) {
    return error instanceof ChatActionError
      ? fail(error.message, error.status)
      : serverError(error);
  }
}
