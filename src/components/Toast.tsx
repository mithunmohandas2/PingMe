"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

export default function Toast({
  message,
  onDismiss,
  duration = 4000,
}: {
  message: string;
  onDismiss: () => void;
  duration?: number;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="notification-toast">
      <div
        className="notification-toast-message"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Check size={18} aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        className="circlebtn"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X size={16} />
      </button>
    </div>,
    document.body,
  );
}
