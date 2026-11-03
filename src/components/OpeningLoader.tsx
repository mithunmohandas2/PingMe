import { MessageCircle } from "lucide-react";

export default function OpeningLoader() {
  return (
    <main
      className="loading opening-loader"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="opening-loader-symbol" aria-hidden="true">
        <span className="opening-loader-ring" />
        <span className="opening-loader-ring delayed" />
        <div className="brandmark">
          <MessageCircle size={34} strokeWidth={1.8} />
        </div>
      </div>
      <p className="opening-loader-label">
        Ping Me <span aria-hidden="true">…</span>
      </p>
      <div className="opening-loader-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="opening-loader-track" aria-hidden="true">
        <span />
      </div>
    </main>
  );
}
