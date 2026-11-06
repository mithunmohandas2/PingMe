"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function PhotoDialog({
  title,
  onClose,
  children,
  expanded = false,
  headerActions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  expanded?: boolean;
  headerActions?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      if (document.fullscreenElement === element)
        void document.exitFullscreen().catch(() => {});
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={"photo-dialog" + (expanded ? " photo-expanded" : "")}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <header className="photo-dialog-head">
        <h3>{title}</h3>
        <div className="photo-dialog-header-actions">
          {headerActions}
          <button
            type="button"
            className="circlebtn"
            aria-label="Close photo"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </header>
      {children}
    </dialog>
  );
}
