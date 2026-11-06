/// <reference lib="webworker" />

import {
  cleanupOutdatedCaches,
  precacheAndRoute,
  createHandlerBoundToURL,
  matchPrecache,
} from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { NavigationRoute, registerRoute, setCatchHandler } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

self.skipWaiting();
clientsClaim();

if (import.meta.env.DEV) {
  // Never cache Vite modules or the dev app shell. Stable request URLs such
  // as /src/main.tsx otherwise get trapped by CacheFirst across restarts and
  // make the preview render an older UI even though the source has changed.
  // Keep the dev worker only for push-notification testing.
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    );
  });
} else {
  cleanupOutdatedCaches();
  precacheAndRoute(self.__WB_MANIFEST);

  registerRoute(
    ({ url }: { url: URL }) => url.pathname.startsWith("/api/"),
    new NetworkFirst({ cacheName: "api-cache", networkTimeoutSeconds: 10 }),
  );

  registerRoute(
    ({ request }: { request: Request }) =>
      ["style", "script", "worker", "image", "font"].includes(request.destination),
    new CacheFirst({ cacheName: "static-assets" }),
  );

  // SPA navigation fallback: every in-app route renders from the
  // precached `index.html` shell. The previous version of this file
  // pointed `NavigationRoute` directly at `offline.html`, which made
  // workbox serve the offline page from the precache for *every*
  // client-side navigation (online or not), so the app appeared to be
  // permanently offline once the SW activated.
  const appShellHandler = createHandlerBoundToURL(
    import.meta.env.BASE_URL + "index.html",
  );
  registerRoute(
    new NavigationRoute(appShellHandler, {
      denylist: [/^\/api\//],
    }),
  );

  // True offline fallback: only when the navigation handler (or any
  // other route) actually throws — e.g. the network is unreachable and
  // the precache lookup misses — fall back to the offline page so the
  // user sees the "Try Again" screen instead of the browser's default
  // dino. Non-document failures just return a network error.
  setCatchHandler(async ({ request }) => {
    if (request.mode === "navigate" || request.destination === "document") {
      const offline = await matchPrecache(
        import.meta.env.BASE_URL + "offline.html",
      );
      if (offline) return offline;
    }
    return Response.error();
  });
}

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  const data = event.data.json() as {
    title: string;
    body: string;
    url?: string;
    tag?: string;
  };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: import.meta.env.BASE_URL + "icon-192.png",
      badge: import.meta.env.BASE_URL + "icon-192.png",
      tag: data.tag ?? "ai-trading",
      data: { url: data.url ?? import.meta.env.BASE_URL },
    })
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const notifUrl: string =
    (event.notification.data as { url?: string })?.url ?? import.meta.env.BASE_URL;
  // Resolve the click destination against the SW scope so per-callsite
  // `url: "/notifications"` opens at the right artifact base path
  // (e.g. /artifacts/ai-trading/notifications).
  const targetUrl = new URL(notifUrl, self.registration.scope).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clientList) => {
        // Prefer an already-open app window: navigate it to the target URL
        // and focus it, so retention warnings land on /notifications even
        // when the user already has the dashboard open.
        for (const client of clientList) {
          const win = client as WindowClient;
          if ("focus" in win) {
            try {
              if ("navigate" in win && win.url !== targetUrl) {
                await win.navigate(targetUrl);
              }
            } catch {
              // Cross-origin navigates throw; just focus the existing window.
            }
            await win.focus();
            return;
          }
        }
        await self.clients.openWindow(targetUrl);
      })
  );
});
