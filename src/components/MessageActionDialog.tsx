"use client";
import { useState } from "react";
import PhotoDialog from "./PhotoDialog";
import type { ChatMessage } from "./MessageBubble";
export default function MessageActionDialog({
  messages,
  onConfirm,
  onClose,
}: {
  messages: ChatMessage[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <PhotoDialog
      title={
        "Delete " +
        messages.length +
        (messages.length === 1 ? " message?" : " messages?")
      }
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="message-edit-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onConfirm();
            onClose();
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "Could not delete messages",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="profile-helper">
          {messages.length === 1
            ? "This message"
            : "These " + messages.length + " messages"}{" "}
          will be deleted permenantly for everyone in this chat.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="photo-dialog-actions">
          <button
            type="button"
            className="secondary-action"
            disabled={busy}
            autoFocus
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="danger" disabled={busy}>
            {busy
              ? "Deleting..."
              : "Delete " +
                (messages.length === 1
                  ? "message"
                  : messages.length + " messages")}
          </button>
        </footer>
      </form>
    </PhotoDialog>
  );
}
