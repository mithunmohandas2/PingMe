"use client";
import { useEffect, useRef, useState } from "react";
import PhotoDialog from "./PhotoDialog";
export default function PhotoCropper({
  file,
  onSave,
  onClose,
  title = "Crop profile photo",
  saveLabel = "Use photo",
  outputSize = 512,
}: {
  file: File;
  onSave: (file: File) => Promise<void>;
  onClose: () => void;
  title?: string;
  saveLabel?: string;
  outputSize?: number;
}) {
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0.5, y: 0.5 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
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
            "This photo could not be opened. Please choose another image.",
          );
      });
    return () => {
      active = false;
      bitmap?.close();
    };
  }, [file]);
  useEffect(() => {
    if (!image || !canvas.current) return;
    const size = Math.min(image.width, image.height) / zoom;
    const context = canvas.current.getContext("2d");
    if (!context) {
      setError("Your browser could not process this photo");
      return;
    }
    context.clearRect(0, 0, outputSize, outputSize);
    context.drawImage(
      image,
      position.x * (image.width - size),
      position.y * (image.height - size),
      size,
      size,
      0,
      0,
      outputSize,
      outputSize,
    );
  }, [image, zoom, position, outputSize]);
  async function save() {
    if (!canvas.current || !image) return;
    setBusy(true);
    setError("");
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.current!.toBlob(
          (value) => {
            if (value?.type === "image/webp") resolve(value);
            else
              reject(new Error("Your browser could not create a WebP photo"));
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
      setError(error instanceof Error ? error.message : "Could not save photo");
    } finally {
      setBusy(false);
    }
  }
  return (
    <PhotoDialog
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="profile-helper">
        Drag to position your photo, or use the controls below.
      </p>
      <div
        className="photo-crop-stage"
        onPointerDown={(event) => {
          if (!image || busy) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            px: position.x,
            py: position.y,
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current || !image) return;
          const size = Math.min(image.width, image.height) / zoom;
          const scale =
            event.currentTarget.getBoundingClientRect().width / size;
          const clamp = (value: number) => Math.max(0, Math.min(1, value));
          setPosition({
            x:
              image.width > size
                ? clamp(
                    drag.current.px -
                      (event.clientX - drag.current.x) /
                        scale /
                        (image.width - size),
                  )
                : 0.5,
            y:
              image.height > size
                ? clamp(
                    drag.current.py -
                      (event.clientY - drag.current.y) /
                        scale /
                        (image.height - size),
                  )
                : 0.5,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <canvas
          ref={canvas}
          width={outputSize}
          height={outputSize}
          aria-label="Cropped photo preview"
        />
        {!image && !error && <span role="status">Opening photo?</span>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="photo-crop-controls" disabled={busy || !image}>
        <label>
          Zoom
          <input
            aria-label="Photo zoom"
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
        <label>
          Horizontal position
          <input
            aria-label="Photo horizontal position"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={position.x}
            onChange={(event) =>
              setPosition({ ...position, x: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Vertical position
          <input
            aria-label="Photo vertical position"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={position.y}
            onChange={(event) =>
              setPosition({ ...position, y: Number(event.target.value) })
            }
          />
        </label>
      </fieldset>
      <footer className="photo-dialog-actions">
        <button
          type="button"
          className="secondary-action"
          disabled={busy}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !image}
          onClick={save}
        >
          {busy ? "Please wait..." : saveLabel}
        </button>
      </footer>
    </PhotoDialog>
  );
}
