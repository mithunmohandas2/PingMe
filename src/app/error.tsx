"use client";

import { useEffect } from "react";
import FailureScreen from "@/components/FailureScreen";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Ping Me page error", error);
  }, [error]);
  return <FailureScreen kind="error" onRetry={reset} />;
}
