/*
 * IdaraWorks service worker — H31.
 *
 * ── Read this before adding a cache ─────────────────────────────────────────
 * This worker deliberately caches NOTHING except one public offline page, and
 * it must stay that way.
 *
 * Every company in IdaraWorks is served from the same paths. `/o/<id>/invoices`
 * is Company A's invoices for one signed-in user and Company B's for another,
 * seconds apart, on a shared device. A response cache here would hold one
 * company's financial data and hand it to whoever asks next — no bug required,
 * just a cache doing its job. The same applies to API responses, PDFs, reports
 * and signed storage URLs.
 *
 * A service worker is NOT required for a web app to be installable (MDN,
 * "Making PWAs installable", read 2026-09-04). So the only thing this one buys
 * is a decent offline screen, and that is all it does.
 *
 * Consequences, stated so nobody has to rediscover them:
 *   - there is no offline reading of business records, by design;
 *   - there is no background sync and no offline write queue, so the app can
 *     never claim a saved transaction that never reached the server;
 *   - signing out or switching company leaves nothing behind to reveal, because
 *     nothing was ever stored.
 */

/*
 * Bump this to invalidate the offline shell. It is part of the cache NAME, so a
 * new version creates a new cache and the activate step deletes the old one —
 * which is what stops a user being stranded on a stale worker.
 */
const VERSION = "h31-1";
const OFFLINE_CACHE = `idaraworks-offline-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      // One page. If it cannot be fetched we install anyway: an offline screen
      // is a nicety, and failing to install would be worse than not having it.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" })).catch(() => {});
      // Take over as soon as possible rather than waiting for every tab to
      // close, so a user is never running last week's worker.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("idaraworks-offline-") && n !== OFFLINE_CACHE)
          .map((n) => caches.delete(n)),
      );
      // Navigation preload lets the browser start the network request while
      // this worker boots, so adding a worker does not make the app slower.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  // The page asks the waiting worker to take over when the user accepts an
  // update. Nothing else is accepted, and no data crosses this channel.
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /*
   * ONLY navigations are touched, and only to show the offline page when the
   * network fails. Everything else — every API call, image, script and style —
   * is left entirely alone, so the browser's own HTTP cache applies with the
   * headers the server actually sent. That is the correct place for caching
   * decisions, because the server knows whether a response was authenticated
   * and this worker does not.
   */
  if (request.mode !== "navigate") return;
  // A non-GET navigation is a form post; replaying or intercepting one is how
  // a duplicate submission happens.
  if (request.method !== "GET") return;

  event.respondWith(
    (async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        return await fetch(request);
      } catch {
        // Genuinely offline. Serve the public shell — never a stored copy of
        // whatever the user was looking at.
        const cache = await caches.open(OFFLINE_CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return (
          offline ??
          new Response("Offline", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        );
      }
    })(),
  );
});
