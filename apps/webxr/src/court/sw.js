// The Court Side Service Worker (P37: a reload works with the cable off), served by serve.mjs at /court-sw.js and
// registered by court.ts in production builds. Every same-origin GET it sees is kept in the cache; the page and the
// bundle come from the network when it answers and from the cache when it doesn't. On install it precaches the page
// and the whole bundle named in /bundle/court.json (every path in it, frames.json included); the page then posts the
// files it loaded before the worker took over ({ type: "cache", urls }), so the build's hashed scripts are kept too.
// That message comes once the page has loaded the show, so the worker then fetches the pre-built fallbacks too
// (?show=small, ?video=element, ?hz=90: ~150 MB), one at a time at low priority, so a cable-off reload with any of
// those flags works and the main path's first load never waits on them. Plain JS (tsc and vite leave it alone). Owned
// by the integrator (the fallback precache: stream C).
const CACHE = "court-side-v1";

/** Every bundle-relative path court.json names (strings that look like files inside the bundle), fallbacks left out. */
function bundlePaths(json) {
  const out = new Set(["court.json"]);
  const walk = (v, key) => {
    if (key === "fallbacks") return; // the pre-built fallbacks are big and fetched only when a URL flag picks one
    if (typeof v === "string" && /^[\w./-]+\.[a-z0-9]{2,5}$/i.test(v) && !v.startsWith("/") && !v.includes("..")) out.add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, k));
  };
  walk(json);
  return [...out];
}

/** Every bundle-relative path under court.json's `fallbacks` (the small stream, pass 1's MP4, the 90 Hz bake). */
function fallbackPaths(json) {
  const out = new Set();
  const walk = (v, inside) => {
    if (inside && typeof v === "string" && /^[\w./-]+\.[a-z0-9]{2,5}$/i.test(v) && !v.startsWith("/") && !v.includes("..")) out.add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, inside));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => walk(x, inside || k === "fallbacks"));
  };
  walk(json, false);
  return [...out];
}

/** The fallbacks not cached yet, fetched one at a time at low priority; one run at a time per worker. */
let fallbacks = null;
function cacheFallbacks() {
  fallbacks ??= (async () => {
    const cache = await caches.open(CACHE);
    const court = await (await fetch("/bundle/court.json", { cache: "no-store" })).json();
    for (const p of fallbackPaths(court)) {
      const url = `/bundle/${p}`;
      if (await cache.match(url)) continue;
      const res = await fetch(url, { priority: "low" }).catch(() => null);
      if (res?.ok) await cache.put(url, res).catch(() => {});
    }
  })()
    .catch(() => {}) // offline, or no bundle: the next page load tries again
    .finally(() => (fallbacks = null));
  return fallbacks;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.add("/");
      try {
        const court = await (await fetch("/bundle/court.json", { cache: "no-store" })).json();
        await Promise.allSettled(bundlePaths(court).map((p) => cache.add(`/bundle/${p}`)));
      } catch {
        // no bundle yet: pages and files are still cached as they are fetched
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const { type, urls } = event.data ?? {};
  if (type !== "cache" || !Array.isArray(urls)) return;
  const same = urls.filter((u) => typeof u === "string" && new URL(u).origin === self.location.origin);
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(same.map(async (u) => (await cache.match(u)) ?? cache.add(u))))
      .then(() => cacheFallbacks()), // the page has its show: now the fallbacks, in the background
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      let res;
      try {
        res = await fetch(req);
      } catch {
        const hit = (await cache.match(req)) ?? (req.mode === "navigate" ? await cache.match("/") : undefined);
        return hit ?? Response.error();
      }
      // the page gets the network's answer at once; the copy is cached alongside (a failed put changes nothing)
      if (res.ok) event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    })(),
  );
});
