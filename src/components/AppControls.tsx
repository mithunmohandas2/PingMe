"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Moon, Sun, X, MoreVertical } from "lucide-react";

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function AppControls() {
  const [menuOpen, setMenuOpen] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(
    null,
  );
  const [installed, setInstalled] = useState(true);
  const [ios, setIos] = useState(false);
  const [help, setHelp] = useState(false);
  const [installing, setInstalling] = useState(false);
  const installButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
    const display = window.matchMedia("(display-mode: standalone)");
    const isIos =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    setIos(isIos);
    const checkInstalled = () => {
      const standalone =
        display.matches ||
        !!(navigator as Navigator & { standalone?: boolean }).standalone;
      let remembered = false;
      try {
        remembered = localStorage.getItem("pingme-installed") === "true";
      } catch {}
      setInstalled(standalone || remembered);
      if (standalone) {
        try {
          localStorage.setItem("pingme-installed", "true");
        } catch {}
      }
    };
    const onPrompt = (event: Event) => {
      event.preventDefault();
      // A fresh browser prompt also handles a previously uninstalled app.
      try {
        localStorage.removeItem("pingme-installed");
      } catch {}
      setInstalled(false);
      setInstallPrompt(event as InstallPrompt);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setHelp(false);
      try {
        localStorage.setItem("pingme-installed", "true");
      } catch {}
    };
    checkInstalled();
    display.addEventListener("change", checkInstalled);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      display.removeEventListener("change", checkInstalled);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!help) return;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHelp(false);
        installButton.current?.focus();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeButton.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help]);

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!controls.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        moreButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "dark" ? "#0b1220" : "#2563eb");
    try {
      localStorage.setItem("pingme-theme", next);
    } catch {}
    setTheme(next);
  }

  async function install() {
    if (!installPrompt) {
      setHelp(true);
      return;
    }
    setInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      setHelp(true);
    } finally {
      setInstallPrompt(null);
      setInstalling(false);
    }
  }

  const closeHelp = () => {
    setHelp(false);
    installButton.current?.focus();
  };
  return (
    <>
      <div
        ref={controls}
        className={"app-controls" + (menuOpen ? " controls-open" : "")}
        role="group"
        aria-label="App controls"
      >
        <div id="chat-selection-actions" className="chat-selection-actions" />
        <button
          ref={moreButton}
          type="button"
          className="circlebtn chat-more-button"
          aria-label="More options"
          aria-expanded={menuOpen}
          aria-controls="app-controls-actions"
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreVertical size={21} />
        </button>
        <div
          id="app-controls-actions"
          className="app-controls-actions"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) {
              setMenuOpen(false);
              if (moreButton.current?.getClientRects().length)
                moreButton.current.focus();
            }
          }}
        >
          {!installed && (
            <button
              ref={installButton}
              className="control-button"
              type="button"
              aria-label="Install Ping Me app"
              title="Install Ping Me app"
              onClick={install}
              disabled={installing}
            >
              <Download size={19} />
              <span className="install-label">Install app</span>
            </button>
          )}
          <button
            className="control-button theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
          </button>
          <div id="mobile-account-actions" className="mobile-account-actions" />
        </div>
      </div>
      {help && (
        <div
          className="overlay install-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeHelp();
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-title"
            aria-describedby="install-description"
          >
            <div className="modalhead">
              <h3 id="install-title">Take Ping Me with you</h3>
              <button
                ref={closeButton}
                type="button"
                className="circlebtn"
                aria-label="Close install instructions"
                onClick={closeHelp}
              >
                <X size={20} />
              </button>
            </div>
            <div className="install-emblem">
              <Download size={30} />
            </div>
            <p id="install-description">
              {ios
                ? "Open this page in Safari, tap Share, then Add to Home Screen and confirm Add."
                : "In Chrome or Edge, open the browser menu and choose Install Ping Me or Install app. On mobile, look for Add to Home Screen. If the option is missing, keep chatting and check again later."}
            </p>
            <p>
              Launch straight into your conversations from your home screen or
              desktop.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
