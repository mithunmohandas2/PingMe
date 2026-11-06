"use client";
import { useState } from "react";
import PhotoDialog from "./PhotoDialog";
export type ChatActionType =
  | "clear"
  | "leave"
  | "block"
  | "unblock"
  | "delete-group";
export default function ChatActionDialog({
  action,
  name,
  onConfirm,
  onClose,
}: {
  action: ChatActionType;
  name: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const title =
    action === "delete-group"
      ? "Delete group permanently?"
      : action === "clear"
        ? "Clear chat for you?"
        : action === "leave"
          ? "Leave group?"
          : action === "block"
            ? "Block user?"
            : "Unblock user?";
  const label =
    action === "delete-group"
      ? "Delete group"
      : action === "clear"
        ? "Clear chat"
        : action === "leave"
          ? "Leave group"
          : action === "block"
            ? "Block user"
            : "Unblock user";
  const text =
    action === "delete-group"
      ? "You are the last member of " +
        name +
        ". This will permanently delete the group, its entire message history, images and chat settings from the database. This cannot be undone."
      : action === "clear"
        ? "Existing messages will be hidden only for you. Other participants keep their history, and new messages will still appear."
        : action === "leave"
          ? "You will leave " +
            name +
            " and lose access to its messages. If you are the admin, another member will become admin."
          : action === "block"
            ? "You will no longer be able to send or receive direct messages with " +
              name +
              " until you unblock them. Existing history and shared groups stay available."
            : "You can exchange direct messages with " +
              name +
              " again unless they have also blocked you.";
  return (
    <PhotoDialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="profile-helper">{text}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="photo-dialog-actions chat-confirm-actions">
        <button
          type="button"
          className="secondary-action"
          autoFocus
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className={action === "unblock" ? "primary" : "danger"}
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await onConfirm();
              onClose();
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "Please try again",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Please wait..." : label}
        </button>
      </footer>
    </PhotoDialog>
  );
}
