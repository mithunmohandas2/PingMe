import type { Metadata } from "next";
import FailureScreen from "@/components/FailureScreen";

export const metadata: Metadata = { title: "Page not found · Ping Me" };

export default function NotFound() {
  return <FailureScreen kind="not-found" />;
}
