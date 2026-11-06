import { UserBlock } from "./models";
export function blockFilter(userId: string, otherId: string) {
  return {
    $or: [
      { blocker: userId, blocked: otherId },
      { blocker: otherId, blocked: userId },
    ],
  };
}
export async function directMessagingBlocked(
  chat: { isGroup?: boolean; users: unknown[]; blockedBy?: unknown[] },
  userId: string,
): Promise<boolean> {
  if (chat.isGroup) return false;
  if (chat.blockedBy?.length) return true;
  const other = chat.users.find((value) => String(value) !== userId);
  return (
    !!other && !!(await UserBlock.exists(blockFilter(userId, String(other))))
  );
}
