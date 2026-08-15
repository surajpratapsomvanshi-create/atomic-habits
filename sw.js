const CACHE = "atomic-habits-v41";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Wipe every cache (not only the previous CACHE name), then reseed current.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c => c.addAll(ASSETS)))
      .then(() => self.clients.claim())
  );
});

function isShellRequest(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return (
      /\/(app\.js|styles\.css|index\.html|sw\.js|manifest\.webmanifest)$/.test(path) ||
      path.endsWith("/atomic-habits") ||
      path.endsWith("/atomic-habits/") ||
      u.pathname.endsWith("/")
    );
  } catch (_) {
    return false;
  }
}

self.addEventListener("fetch", e => {
  // never cache sync calls to Apps Script
  if (e.request.url.includes("script.google.com")) return;
  if (e.request.url.includes("script.googleusercontent.com")) return;
  if (e.request.method !== "GET") return;

  // Network-first for app shell so new logic reaches phones stuck on old caches.
  if (isShellRequest(e.request.url) || e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request, { cache: "no-store" })
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(hit => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
