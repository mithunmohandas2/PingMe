// Cache only public artwork. Next.js owns caching for its scripts and styles.
const CACHE = "pingme-static-v2";
const ASSETS = new Set([
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/images/auth-connections.svg",
]);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/icon.svg"]))
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
  const req = event.request;
  const url = new URL(req.url);
  // Never intercept scripts, styles, navigations, APIs, or private user data.
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    req.mode === "navigate" ||
    !ASSETS.has(url.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(req);
        if (response.ok) await cache.put(req, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(req);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
