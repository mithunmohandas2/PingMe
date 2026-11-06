"use client";
import ImageMessageSummary, {
  useMessageRetentionExpired,
} from "./ImageMessageStatus";
import type { ChatMessage } from "./MessageBubble";
export default function MessagePreview({ message }: { message: ChatMessage }) {
  const purged = useMessageRetentionExpired(message);
  if (purged) return <>No recent messages</>;
  if (message.deletedAt) return <em>Message has been deleted</em>;
  if (message.kind === "image")
    return <ImageMessageSummary message={message} />;
  return message.kind === "group-rename" ? (
    <em>{message.content}</em>
  ) : (
    <>{message.content}</>
  );
}
