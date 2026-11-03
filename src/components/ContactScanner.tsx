"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Link, X } from "lucide-react";
import { parseContactLink } from "@/lib/contacts";

export default function ContactScanner({
  onContact,
  onClose,
}: {
  onContact: (id: string) => void;
  onClose: () => void;
}) {
  const [camera, setCamera] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const video = useRef<HTMLVideoElement>(null),
    close = useRef<HTMLButtonElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null),
    onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onContactRef = useRef(onContact);
  onContactRef.current = onContact;
  const connect = (value: string) => {
    const id = parseContactLink(value, window.location.origin);
    if (!id) {
      setError(
        "This isn’t a contact link for this Ping Me app. Try another QR code.",
      );
      return false;
    }
    setCamera(false);
    onContactRef.current(id);
    return true;
  };
  useEffect(() => {
    close.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        const controls = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not([hidden]):not(:disabled)",
          ) || []),
        ];
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);
  useEffect(() => {
    if (!camera) return;
    let stopped = false,
      stream: MediaStream | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const pause = () => {
      if (document.visibilityState === "hidden") setCamera(false);
    };
    document.addEventListener("visibilitychange", pause);
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error(
            "Camera access is unavailable. Open Ping Me over HTTPS, or upload a QR image below.",
          );
        const { default: jsQR } = await import("jsqr");
        if (stopped) return;
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
          },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const player = video.current;
        if (!player) return;
        player.srcObject = stream;
        await player.play();
        if (stopped) return;
        const canvas = document.createElement("canvas"),
          context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context)
          throw new Error(
            "Could not read camera images. Try uploading a QR image.",
          );
        const scan = () => {
          if (stopped) return;
          if (player.readyState >= 2 && player.videoWidth) {
            const scale = Math.min(
              1,
              800 / Math.max(player.videoWidth, player.videoHeight),
            );
            canvas.width = Math.round(player.videoWidth * scale);
            canvas.height = Math.round(player.videoHeight * scale);
            context.drawImage(player, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            const code = jsQR(image.data, image.width, image.height);
            if (code && connect(code.data)) return;
          }
          timer = setTimeout(scan, 300);
        };
        scan();
      } catch (error) {
        if (!stopped) {
          setError(
            (error as Error).name === "NotAllowedError"
              ? "Camera permission was denied. Allow camera access or upload a QR image."
              : (error as Error).message,
          );
          setCamera(false);
        }
      }
    };
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
      document.removeEventListener("visibilitychange", pause);
    };
  }, [camera]);

  async function readImage(file: File) {
    setBusy(true);
    setCamera(false);
    setError("");
    try {
      if (file.size > 12 * 1024 * 1024)
        throw new Error("Choose a QR image smaller than 12 MB");
      const { default: jsQR } = await import("jsqr");
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = document.createElement("canvas"),
          scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Could not read this image");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height),
          code = jsQR(image.data, image.width, image.height);
        if (!code) throw new Error("No QR code found. Try a clearer image.");
        connect(code.data);
      } finally {
        bitmap.close();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  return (
    <div
      className="overlay scanner-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        className="modal scanner-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scanner-title"
      >
        <div className="modalhead">
          <h3 id="scanner-title">Scan a contact</h3>
          <button
            ref={close}
            className="circlebtn"
            aria-label="Close scanner"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Scan someone’s Ping Me QR code to preview their profile and connect.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className={"scanner-camera " + (camera ? "active" : "")}>
          <video
            ref={video}
            muted
            playsInline
            aria-label="QR scanner camera preview"
          />
          {!camera && <Camera size={44} />}
          <span>
            {camera
              ? "Point your camera at a Ping Me QR code"
              : "Your camera stays off until you start scanning"}
          </span>
        </div>
        <div className="contact-share-actions">
          <button
            className="secondary-action"
            disabled={busy}
            onClick={() => {
              setError("");
              setCamera(!camera);
            }}
          >
            <Camera size={16} />
            {camera ? "Stop camera" : "Start camera"}
          </button>
          <button
            className="secondary-action"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus size={16} />
            {busy ? "Reading…" : "Upload QR"}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          aria-label="Upload QR image"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readImage(file);
          }}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect(link);
          }}
        >
          <label>
            Or paste a Ping Me link
            <input
              type="url"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="https://…/?connect=…"
              required
            />
          </label>
          <button type="submit" className="primary wide" disabled={busy}>
            <Link size={16} /> Preview contact
          </button>
        </form>
      </section>
    </div>
  );
}
