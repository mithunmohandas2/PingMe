"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  UserRound,
  KeyRound,
  QrCode,
  Camera,
  Copy,
  Download,
  Link as LinkIcon,
  LogOut,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import PhotoCropper from "./PhotoCropper";
import PhotoDialog from "./PhotoDialog";
import PhotoPreview from "./PhotoPreview";
import Toast from "./Toast";
import { compressImage } from "@/lib/compress-image";
import { contactLink, type ContactUser } from "@/lib/contacts";

async function profileRequest<T>(
  path: string,
  options: RequestInit,
): Promise<T> {
  const response = await fetch("/api/profile" + path, options);
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message || "Could not update your profile");
  return result.data;
}

export default function ProfilePanel({
  user,
  onUpdated,
  onClose,
  onSignOut,
  onDeleted,
  closeButtonRef,
}: {
  user: ContactUser;
  onUpdated: (user: ContactUser) => void;
  onClose: () => void;
  onSignOut: () => void;
  onDeleted: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [confirmAccountDelete, setConfirmAccountDelete] = useState(false);
  const [accountPassword, setAccountPassword] = useState("");
  const [accountAcknowledged, setAccountAcknowledged] = useState(false);
  const [accountDeleteError, setAccountDeleteError] = useState("");
  const [showPhoto, setShowPhoto] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [tab, setTab] = useState<"details" | "security" | "share" | "delete">(
    "details",
  );
  const [name, setName] = useState(user.name),
    [email, setEmail] = useState(user.email),
    [bio, setBio] = useState(user.bio || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [link, setLink] = useState(""),
    [qr, setQr] = useState("");
  const photoInput = useRef<HTMLInputElement>(null),
    linkInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setLink(contactLink(window.location.origin, user._id));
  }, [user._id]);
  useEffect(() => {
    if (tab !== "share" || !link) return;
    let active = true;
    import("qrcode")
      .then((QR) =>
        QR.toDataURL(link, {
          width: 320,
          margin: 4,
          errorCorrectionLevel: "M",
          color: { dark: "#0b1b36", light: "#ffffff" },
        }),
      )
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active)
          setError(
            "Could not generate your QR code. You can still copy your link.",
          );
      });
    return () => {
      active = false;
    };
  }, [tab, link]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Please try again");
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    setBusy(true);
    try {
      const image = await compressImage(file, {
        maxWidth: 512,
        quality: 0.8,
        thresholdKB: 200,
      });
      const form = new FormData();
      form.set("image", image);
      const updated = await profileRequest<ContactUser>("/avatar", {
        method: "POST",
        body: form,
      });
      onUpdated(updated);
      setNotice("Profile photo updated.");
      setError("");
    } finally {
      setBusy(false);
    }
    if (photoInput.current) photoInput.current.value = "";
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Contact link copied.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setNotice("Select and copy your contact link below.");
    }
  }
  async function share() {
    if (!navigator.share) {
      await copyLink();
      return;
    }
    try {
      await navigator.share({
        title: `Chat with ${user.name} on Ping Me`,
        text: "Let’s connect on Ping Me",
        url: link,
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") await copyLink();
    }
  }
  function changeTab(next: typeof tab) {
    setTab(next);
    setError("");
    setNotice("");
    setCurrentPassword("");
  }

  return (
    <div
      className="overlay profile-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      {notice && <Toast message={notice} onDismiss={() => setNotice("")} />}
      {confirmAccountDelete && (
        <PhotoDialog
          title="Permanently delete your account?"
          onClose={() => {
            if (!busy) setConfirmAccountDelete(false);
          }}
        >
          <p className="profile-helper">
            You will be signed out immediately and cannot recover this account.
            Your direct chats and your messages in shared groups will be
            permanently removed after 15 days.
          </p>
          {accountDeleteError && (
            <p className="error" role="alert">
              {accountDeleteError}
            </p>
          )}
          <footer className="photo-dialog-actions">
            <button
              type="button"
              className="secondary-action"
              autoFocus
              disabled={busy}
              onClick={() => setConfirmAccountDelete(false)}
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
                setAccountDeleteError("");
                try {
                  await profileRequest("/account", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      currentPassword: accountPassword,
                      confirmation: "DELETE",
                    }),
                  });
                  onDeleted();
                } catch (error) {
                  setAccountDeleteError(
                    error instanceof Error
                      ? error.message
                      : "Could not delete account",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting..." : "Confirm delete account"}
            </button>
          </footer>
        </PhotoDialog>
      )}
      {showPhoto && user.image && (
        <PhotoPreview
          image={user.image}
          name={user.name}
          onClose={() => setShowPhoto(false)}
        />
      )}
      {confirmRemove && (
        <PhotoDialog
          title="Remove profile photo?"
          onClose={() => setConfirmRemove(false)}
        >
          <p className="profile-helper">
            Your profile photo will be removed. You can upload a new one
            anytime.
          </p>
          <footer className="photo-dialog-actions">
            <button
              type="button"
              className="secondary-action"
              autoFocus
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirmRemove(false);
                void perform(async () => {
                  onUpdated(
                    await profileRequest<ContactUser>("/avatar", {
                      method: "DELETE",
                    }),
                  );
                  setNotice("Profile photo removed.");
                });
              }}
            >
              Remove photo
            </button>
          </footer>
        </PhotoDialog>
      )}
      {cropFile && (
        <PhotoCropper
          file={cropFile}
          onSave={upload}
          onClose={() => setCropFile(null)}
        />
      )}
      <section
        className="modal profile-modal profile-editor"
        role="dialog"
        aria-labelledby="profile-title"
        aria-busy={busy}
      >
        <div className="modalhead">
          <h3 id="profile-title">Your profile</h3>
          <button
            ref={closeButtonRef}
            className="circlebtn"
            aria-label="Close profile"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="profile-workspace">
          <aside className="profile-sidebar">
            <nav className="profile-tabs" aria-label="Profile settings">
              {(
                [
                  ["details", "Details", UserRound],
                  ["security", "Password", KeyRound],
                  ["share", "Share contact", QrCode],
                  ["delete", "Delete account", Trash2],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  className={
                    (tab === value ? "selected " : "") +
                    (value === "delete" ? "account-delete-tab" : "")
                  }
                  aria-label={label}
                  title={label}
                  aria-pressed={tab === value}
                  onClick={() => changeTab(value)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <button
              className="text-action profile-signout"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              disabled={busy}
            >
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
          </aside>
          <div className="profile-content">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {tab === "details" && (
              <div className="profile-details-layout">
                <div className="profile-photo-section">
                  <div className="profile-photo-row">
                    {user.image ? (
                      <button
                        type="button"
                        className="avatar big avatar-preview-trigger"
                        aria-label="View your profile photo"
                        title="View profile photo"
                        onClick={() => setShowPhoto(true)}
                      >
                        <img src={user.image} alt={user.name + "'s profile"} />
                      </button>
                    ) : (
                      <div className="avatar big">
                        <span>{user.name.slice(0, 2).toUpperCase()}</span>
                      </div>
                    )}
                    <div className="photo-actions">
                      <button
                        className="secondary-action"
                        disabled={busy}
                        onClick={() => photoInput.current?.click()}
                      >
                        <Camera size={16} />
                        {busy ? "Please wait…" : "Change photo"}
                      </button>
                      {user.image && (
                        <button
                          className="text-action danger"
                          disabled={busy}
                          aria-label="Remove profile photo"
                          onClick={() => setConfirmRemove(true)}
                        >
                          <Trash2 size={14} />
                          Remove
                        </button>
                      )}
                    </div>
                    <input
                      ref={photoInput}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      hidden
                      aria-label="Choose profile photo"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        setError("");
                        if (
                          !["image/jpeg", "image/png", "image/webp"].includes(
                            file.type,
                          )
                        ) {
                          setError("Choose a JPEG, PNG or WebP photo");
                        } else if (file.size > 12 * 1024 * 1024) {
                          setError("Choose a photo smaller than 12 MB");
                        } else setCropFile(file);
                      }}
                    />
                  </div>
                  <p className="profile-helper">
                    JPEG, PNG or WebP, up to 12 MB. Photos are resized and saved
                    as WebP.
                  </p>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async () => {
                      const updated = await profileRequest<ContactUser>("", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          name,
                          email,
                          bio,
                          currentPassword,
                        }),
                      });
                      onUpdated(updated);
                      setName(updated.name);
                      setEmail(updated.email);
                      setBio(updated.bio || "");
                      setCurrentPassword("");
                      setNotice("Profile updated.");
                    });
                  }}
                >
                  <fieldset
                    disabled={busy}
                    className="profile-fields profile-details-fields"
                  >
                    <label>
                      Full name
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        minLength={2}
                        maxLength={80}
                        required
                        autoComplete="name"
                      />
                    </label>
                    <label>
                      Email address
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                        maxLength={254}
                        autoComplete="email"
                      />
                    </label>
                    {email.trim().toLowerCase() !== user.email && (
                      <label className="profile-field-full">
                        Current password{" "}
                        <small>to confirm your email change</small>
                        <input
                          type="password"
                          value={currentPassword}
                          onChange={(event) =>
                            setCurrentPassword(event.target.value)
                          }
                          required
                          autoComplete="current-password"
                        />
                      </label>
                    )}
                    <label className="profile-field-full">
                      About you
                      <textarea
                        value={bio}
                        onChange={(event) => setBio(event.target.value)}
                        maxLength={160}
                        rows={3}
                        placeholder="A little about yourself"
                      />
                      <small>{bio.length}/160</small>
                    </label>
                    <button className="primary wide" type="submit">
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                  </fieldset>
                </form>
              </div>
            )}
            {tab === "security" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget,
                    values = new FormData(form);
                  if (
                    values.get("newPassword") !== values.get("confirmPassword")
                  ) {
                    setError("New passwords do not match");
                    return;
                  }
                  void perform(async () => {
                    const result = await profileRequest<{ message: string }>(
                      "/password",
                      {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          currentPassword: values.get("currentPassword"),
                          newPassword: values.get("newPassword"),
                        }),
                      },
                    );
                    form.reset();
                    setNotice(result.message);
                  });
                }}
              >
                <p className="profile-helper">
                  Choose a strong password you haven’t used elsewhere. Other
                  sessions will be signed out.
                </p>
                <fieldset
                  disabled={busy}
                  className="profile-fields profile-security-fields"
                >
                  <label className="profile-field-full">
                    Current password
                    <input
                      type="password"
                      name="currentPassword"
                      required
                      autoComplete="current-password"
                      maxLength={128}
                    />
                  </label>
                  <label>
                    New password
                    <input
                      type="password"
                      name="newPassword"
                      required
                      minLength={8}
                      maxLength={72}
                      autoComplete="new-password"
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      type="password"
                      name="confirmPassword"
                      required
                      minLength={8}
                      maxLength={72}
                      autoComplete="new-password"
                    />
                  </label>
                  <button type="submit" className="primary wide">
                    {busy ? "Updating…" : "Change password"}
                  </button>
                </fieldset>
              </form>
            )}
            {tab === "delete" && (
              <section className="profile-delete-account">
                <h4>Delete account</h4>
                <p>
                  This action is permanent. You will lose access to your account
                  immediately.
                </p>
                <ul>
                  <li>
                    Your name, email, photo and profile details will be removed.
                  </li>
                  <li>
                    Others will see a deleted-account placeholder and cannot
                    send messages in your direct chats.
                  </li>
                  <li>
                    Your entire direct-chat history will be permanently removed
                    after 15 days.
                  </li>
                  <li>
                    Shared groups will stay usable. Your messages there will be
                    removed after 15 days; other members' messages will remain.
                  </li>
                </ul>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    setAccountDeleteError("");
                    setConfirmAccountDelete(true);
                  }}
                >
                  <label>
                    Current password
                    <input
                      type="password"
                      name="deleteAccountPassword"
                      autoComplete="current-password"
                      required
                      maxLength={128}
                      value={accountPassword}
                      onChange={(event) =>
                        setAccountPassword(event.target.value)
                      }
                      disabled={busy}
                    />
                  </label>
                  <label className="account-delete-ack">
                    <input
                      type="checkbox"
                      required
                      checked={accountAcknowledged}
                      onChange={(event) =>
                        setAccountAcknowledged(event.target.checked)
                      }
                      disabled={busy}
                    />
                    <span>I understand that deletion is permanent.</span>
                  </label>
                  <button
                    type="submit"
                    className="danger"
                    disabled={busy || !accountAcknowledged || !accountPassword}
                  >
                    Delete account
                  </button>
                </form>
              </section>
            )}
            {tab === "share" && (
              <div className="contact-share">
                <p className="profile-helper">
                  Let someone scan your code or open your link to start a
                  conversation with you.
                </p>
                <div className="contact-qr">
                  {qr ? (
                    <img
                      src={qr}
                      alt={`Scan to connect with ${user.name} on Ping Me`}
                      width={240}
                      height={240}
                    />
                  ) : (
                    <p role="status">Preparing your QR code…</p>
                  )}
                </div>
                <strong>{user.name}</strong>
                <label className="contact-link-label">
                  <LinkIcon size={14} />
                  Your Ping Me link
                  <input
                    ref={linkInput}
                    readOnly
                    value={link}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <div className="contact-share-actions">
                  <button className="secondary-action" onClick={copyLink}>
                    <Copy size={16} />
                    Copy link
                  </button>
                  <button className="secondary-action" onClick={share}>
                    <Share2 size={16} />
                    Share
                  </button>
                  {qr && (
                    <a
                      className="secondary-action"
                      href={qr}
                      download="ping-me-contact.png"
                    >
                      <Download size={16} />
                      Save QR
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
