"use client";

import { useEffect } from "react";
import FailureScreen from "@/components/FailureScreen";
import "./fonts.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Ping Me application error", error);
  }, [error]);
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Ping Me</title>
      </head>
      <body style={{ margin: 0 }}>
        <FailureScreen kind="error" onRetry={reset} />
      </body>
    </html>
  );
}
