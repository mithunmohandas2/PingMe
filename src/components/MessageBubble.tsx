"use client";
import { useEffect, useRef, useState } from "react";
import PhotoPreview from "./PhotoPreview";
import {
  useImageStatus,
  useMessageRetentionExpired,
} from "./ImageMessageStatus";
export type ChatMessage = {
  _id: string;
  sender: { _id: string; name: string; email: string; image?: string };
  content: string;
  createdAt: string;
  kind?: "text" | "image" | "group-rename";
  imageExpiresAt?: string | null;
  accountPurgeAt?: string | null;
  updatedAt?: string;
  editedAt?: string | null;
  deletedAt?: string | null;
};
export default function MessageBubble({
  message,
  own,
  group,
  selected,
  selecting,
  onSelect,
}: {
  message: ChatMessage;
  own: boolean;
  group: boolean;
  selected: boolean;
  selecting: boolean;
  onSelect: (id: string) => void;
}) {
  const purged = useMessageRetentionExpired(message);
  const { expired, remaining } = useImageStatus(message);
  const [preview, setPreview] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    if (expired) setPreview(false);
  }, [expired]);
  const imageAvailable =
    message.kind === "image" && !expired && !message.deletedAt;
  const imageUrl = "/api/messages/image/" + encodeURIComponent(message._id);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const canSelect =
    own && !message.deletedAt && !expired && message.kind !== "group-rename";
  function cancelPress() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  if (purged) return null;
  return (
    <div
      className={
        "bubble" +
        (message.deletedAt || expired || message.kind === "group-rename"
          ? " message-deleted"
          : "") +
        (imageAvailable ? " image-message" : "") +
        (canSelect ? " selectable-message" : "") +
        (selected ? " message-selected" : "")
      }
      tabIndex={canSelect || imageAvailable ? 0 : undefined}
      role={canSelect || imageAvailable ? "button" : undefined}
      aria-label={
        canSelect
          ? selected
            ? "Deselect message"
            : "Select message"
          : imageAvailable
            ? "Open shared image"
            : undefined
      }
      aria-pressed={canSelect ? selected : undefined}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog")) return;
        if (!canSelect || event.button !== 0 || event.isPrimary === false)
          return;
        held.current = false;
        cancelPress();
        origin.current = { x: event.clientX, y: event.clientY };
        if (!selecting)
          timer.current = setTimeout(() => {
            timer.current = null;
            held.current = true;
            onSelect(message._id);
          }, 500);
      }}
      onPointerMove={(event) => {
        if (
          Math.hypot(
            event.clientX - origin.current.x,
            event.clientY - origin.current.y,
          ) > 10
        )
          cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        if (canSelect) event.preventDefault();
      }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("dialog")) return;
        if (held.current) {
          held.current = false;
          return;
        }
        if (canSelect && selecting) onSelect(message._id);
        else if (imageAvailable && !selecting) setPreview(true);
      }}
      onKeyDown={(event) => {
        if (
          !canSelect &&
          imageAvailable &&
          (event.key === " " || event.key === "Enter")
        ) {
          event.preventDefault();
          setPreview(true);
        }
        if (canSelect && (event.key === " " || event.key === "Enter")) {
          event.preventDefault();
          onSelect(message._id);
        }
      }}
    >
      {message.deletedAt ? (
        <p>
          <em>Message has been deleted</em>
        </p>
      ) : expired ? (
        <p>
          <em>Image auto deleted</em>
        </p>
      ) : message.kind === "group-rename" ? (
        <p>
          <em>{message.content}</em>
        </p>
      ) : (
        <>
          {group && !own && <b>{message.sender.name}</b>}
          {message.kind === "image" ? (
            imageFailed ? (
              <p>Image unavailable</p>
            ) : (
              <img
                className="chat-image"
                src={imageUrl}
                alt="Shared image"
                draggable={false}
                onError={() => setImageFailed(true)}
              />
            )
          ) : (
            <p>{message.content}</p>
          )}
          <div className="message-meta">
            <span className="message-stamp">
              {imageAvailable && (
                <span
                  className="image-countdown"
                  title="Time until image is automatically deleted"
                  aria-label={"Image expires in " + remaining}
                >
                  {remaining} left
                </span>
              )}
              {message.editedAt && (
                <span className="message-edited">edited</span>
              )}
              <time dateTime={message.createdAt}>
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </span>
          </div>
        </>
      )}
      {preview && imageAvailable && (
        <PhotoPreview
          title="Shared image"
          name={message.sender.name}
          image={imageUrl}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
  );
}
