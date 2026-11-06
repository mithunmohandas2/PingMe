// Public artwork and an offline reconnect page only. Never store private chats.
const CACHE = "pingme-static-v3";
const OFFLINE = "/offline.html";
const ASSETS = new Set([
  "/icon.svg",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/images/auth-connections.svg",
]);
const PRECACHE = [
  OFFLINE,
  "/icon.svg?v=3",
  "/icons/icon-192.png?v=3",
  "/icons/icon-512.png?v=3",
  "/icons/icon-maskable-512.png?v=3",
  "/icons/apple-touch-icon.png?v=3",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("pingme-static-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_next/")
  )
    return;
  if (req.mode === "navigate") {
    // Fetch fresh HTML online; offline, show a public page rather than private cached HTML.
    event.respondWith(
      fetch(req).catch(
        async () =>
          (await (await caches.open(CACHE)).match(OFFLINE)) ||
          new Response("You are offline. Please reconnect to Ping Me.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    return;
  }
  if (!ASSETS.has(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(req);
        if (response.ok) {
          try {
            await cache.put(req, response.clone());
          } catch {}
        }
        return response;
      } catch (error) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
