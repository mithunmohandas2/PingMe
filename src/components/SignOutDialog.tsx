"use client";
import { useState } from "react";
import PhotoDialog from "./PhotoDialog";
export default function SignOutDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <PhotoDialog
      title="Sign out?"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="profile-helper">
        You will need to sign in again to continue chatting.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="photo-dialog-actions signout-confirm-actions">
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
          className="danger"
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
                error instanceof Error
                  ? error.message
                  : "Could not sign out. Please try again.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Signing out..." : "Sign out"}
        </button>
      </footer>
    </PhotoDialog>
  );
}
