"use client";

import { Home, MessageCircle, RotateCw } from "lucide-react";
import styles from "./FailureScreen.module.css";

export default function FailureScreen({
  kind,
  onRetry,
}: {
  kind: "error" | "not-found";
  onRetry?: () => void;
}) {
  const missing = kind === "not-found";
  return (
    <main className={styles.screen}>
      <a className={styles.brand} href="/" aria-label="Ping Me home">
        <span className={styles.brandIcon}>
          <MessageCircle size={23} aria-hidden="true" />
        </span>
        Ping Me
      </a>
      <section className={styles.card} aria-labelledby="failure-title">
        <div className={styles.illustration} aria-hidden="true">
          <MessageCircle size={64} strokeWidth={1.4} />
          <span>{missing ? "?" : "!"}</span>
        </div>
        <p className={styles.code}>
          {missing ? "404 · PAGE NOT FOUND" : "SOMETHING WENT WRONG"}
        </p>
        <h1 id="failure-title">
          {missing
            ? "This conversation took a detour."
            : "Let’s get you connected again."}
        </h1>
        <p className={styles.description}>
          {missing
            ? "We couldn’t find this page. The link may have changed, or the address might have a typo."
            : "Ping Me ran into a problem loading this page. Try again, or reload the app for a fresh start."}
        </p>
        <div className={styles.actions}>
          {missing ? (
            <a className={styles.primary} href="/">
              <Home size={18} aria-hidden="true" />
              Back to Ping Me
            </a>
          ) : (
            <>
              <button
                className={styles.primary}
                type="button"
                onClick={onRetry}
              >
                <RotateCw size={18} aria-hidden="true" />
                Try again
              </button>
              <button
                className={styles.secondary}
                type="button"
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
            </>
          )}
        </div>
        {!missing && (
          <a className={styles.homeLink} href="/">
            Back to home
          </a>
        )}
      </section>
      <p className={styles.footer}>Better conversations. Closer connections.</p>
    </main>
  );
}
