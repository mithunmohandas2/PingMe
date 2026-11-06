"use client";
import { useEffect, useRef, useState } from "react";
import { Crop, RotateCcw } from "lucide-react";
import PhotoDialog from "./PhotoDialog";
type Rect = { x: number; y: number; width: number; height: number };
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export default function ChatImageEditor({
  file,
  onSave,
  onClose,
}: {
  file: File;
  onSave: (file: File) => Promise<void>;
  onClose: () => void;
}) {
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [cropping, setCropping] = useState(false);
  const [crop, setCrop] = useState<Rect>({
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    rect: Rect;
    handle: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    let bitmap: ImageBitmap | undefined;
    createImageBitmap(file)
      .then((value) => {
        bitmap = value;
        if (active) setImage(value);
        else value.close();
      })
      .catch(() => {
        if (active)
          setError(
            "This image could not be opened. Please choose another image.",
          );
      });
    return () => {
      active = false;
      bitmap?.close();
    };
  }, [file]);
  useEffect(() => {
    if (!image || !canvas.current) return;
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    canvas.current.width = Math.max(1, Math.round(image.width * scale));
    canvas.current.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.current.getContext("2d");
    if (!context) {
      setError("Your browser could not process this image");
      return;
    }
    context.drawImage(image, 0, 0, canvas.current.width, canvas.current.height);
  }, [image]);
  async function send(useCrop: boolean) {
    if (!image || busy) return;
    setBusy(true);
    setError("");
    try {
      const rect = useCrop ? crop : { x: 0, y: 0, width: 1, height: 1 };
      const width = image.width * rect.width,
        height = image.height * rect.height;
      const scale = Math.min(1, 1024 / Math.max(width, height));
      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.round(width * scale));
      output.height = Math.max(1, Math.round(height * scale));
      const context = output.getContext("2d");
      if (!context)
        throw new Error("Your browser could not process this image");
      context.drawImage(
        image,
        image.width * rect.x,
        image.height * rect.y,
        width,
        height,
        0,
        0,
        output.width,
        output.height,
      );
      const blob = await new Promise<Blob>((resolve, reject) =>
        output.toBlob(
          (value) => {
            if (value?.type === "image/webp") resolve(value);
            else
              reject(new Error("Your browser could not create a WebP image"));
          },
          "image/webp",
          0.8,
        ),
      );
      await onSave(
        new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", {
          type: "image/webp",
        }),
      );
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send image");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PhotoDialog
      title="Send image"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="profile-helper">
        Send the full image, or resize and drag the crop box. Images expire one
        hour after sending.
      </p>
      <div
        className="chat-crop-stage"
        style={
          image
            ? {
                width:
                  "min(100%, " + (40 * image.width) / image.height + "dvh)",
              }
            : undefined
        }
        onPointerDown={(event) => {
          if (
            !cropping ||
            busy ||
            !(event.target as HTMLElement).closest(".chat-crop-box")
          )
            return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            rect: crop,
            handle: (event.target as HTMLElement).dataset.cropHandle || "move",
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const { rect, handle } = drag.current,
            frame = event.currentTarget.getBoundingClientRect();
          const dx = (event.clientX - drag.current.x) / frame.width,
            dy = (event.clientY - drag.current.y) / frame.height;
          if (handle === "move") {
            setCrop({
              ...rect,
              x: clamp(rect.x + dx, 0, 1 - rect.width),
              y: clamp(rect.y + dy, 0, 1 - rect.height),
            });
            return;
          }
          let left = rect.x,
            top = rect.y,
            right = rect.x + rect.width,
            bottom = rect.y + rect.height;
          if (handle.includes("w")) left = clamp(rect.x + dx, 0, right - 0.05);
          if (handle.includes("e"))
            right = clamp(rect.x + rect.width + dx, left + 0.05, 1);
          if (handle.includes("n")) top = clamp(rect.y + dy, 0, bottom - 0.05);
          if (handle.includes("s"))
            bottom = clamp(rect.y + rect.height + dy, top + 0.05, 1);
          setCrop({
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <canvas ref={canvas} aria-label="Chat image preview" />
        {image && cropping && (
          <div
            className="chat-crop-box"
            style={{
              left: crop.x * 100 + "%",
              top: crop.y * 100 + "%",
              width: crop.width * 100 + "%",
              height: crop.height * 100 + "%",
            }}
          >
            {["nw", "ne", "sw", "se"].map((handle) => (
              <span
                key={handle}
                className={"crop-handle " + handle}
                data-crop-handle={handle}
              />
            ))}
          </div>
        )}
        {!image && !error && <p role="status">Opening image...</p>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-crop-tools">
        <button
          type="button"
          className="secondary-action"
          disabled={busy || !image}
          aria-pressed={cropping}
          onClick={() => setCropping((value) => !value)}
        >
          <Crop size={16} />
          {cropping ? "Use full image" : "Crop image"}
        </button>
        {cropping && (
          <button
            type="button"
            className="text-action"
            disabled={busy}
            onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}
          >
            <RotateCcw size={14} />
            Reset crop
          </button>
        )}
      </div>
      <footer className="photo-dialog-actions chat-image-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        {cropping && (
          <button
            type="button"
            className="secondary-action send-full-image"
            disabled={busy || !image}
            onClick={() => void send(false)}
          >
            Send without crop
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={busy || !image}
          onClick={() => void send(cropping)}
        >
          {busy
            ? "Sending..."
            : cropping
              ? "Send cropped image"
              : "Send without crop"}
        </button>
      </footer>
    </PhotoDialog>
  );
}
