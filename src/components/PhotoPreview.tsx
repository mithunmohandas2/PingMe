"use client";
import { useEffect, useState } from "react";
import { Maximize, Minimize } from "lucide-react";
import PhotoDialog from "./PhotoDialog";
export default function PhotoPreview({
  image,
  name,
  onClose,
  title,
}: {
  image: string;
  name: string;
  onClose: () => void;
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const changed = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  return (
    <PhotoDialog
      title={title || name + "'s profile photo"}
      onClose={onClose}
      expanded={expanded}
      headerActions={
        <button
          className="circlebtn"
          aria-label={expanded ? "Exit fullscreen" : "Fullscreen"}
          title={expanded ? "Exit fullscreen" : "Fullscreen"}
          type="button"
          onClick={async (event) => {
            const dialog = event.currentTarget.closest("dialog")!;
            if (expanded) {
              if (document.fullscreenElement === dialog)
                await document.exitFullscreen().catch(() => {});
              setExpanded(false);
            } else {
              setExpanded(true);
              if (dialog.requestFullscreen)
                await dialog.requestFullscreen().catch(() => {});
            }
          }}
        >
          {expanded ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      }
    >
      <div className="photo-preview-image">
        {failed ? (
          <p role="alert">This photo could not be loaded.</p>
        ) : (
          <img
            src={image}
            alt={title || name + "'s profile photo"}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </PhotoDialog>
  );
}
