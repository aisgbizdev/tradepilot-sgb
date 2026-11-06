import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { copyFileSync, existsSync } from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { VitePWA } from "vite-plugin-pwa";

// SPA history fallback for static hosts.
//
// This is a client-side-routed SPA: a direct hit / refresh on any route
// other than `/` (e.g. `/privacy`, `/login`, `/dashboard`) needs the host
// to serve `index.html` so the router can take over. The api-server does
// this itself (`app.ts`, the NODE_ENV=production block), but when a static
// file server sits in front of it and answers non-API paths directly, that
// fallback never runs and the user gets a raw 404.
//
// Emitting `index.html` under the two filenames static hosts recognise as
// their SPA fallback covers that case without any host config:
//   - `404.html` — GitHub Pages, Firebase Hosting, Replit static, Cloudflare Pages
//   - `200.html` — Surge, Render static, a few others
//
// Runs in `closeBundle` (after VitePWA), so these copies are NOT added to
// the service-worker precache — they only exist as server-side fallbacks.
function spaFallbackHtml(): Plugin {
  return {
    name: "spa-fallback-html",
    apply: "build",
    enforce: "post",
    closeBundle() {
      const outDir = path.resolve(import.meta.dirname, "dist/public");
      const index = path.join(outDir, "index.html");
      if (!existsSync(index)) return;
      for (const name of ["404.html", "200.html"]) {
        copyFileSync(index, path.join(outDir, name));
      }
    },
  };
}

// PORT and BASE_PATH are only required when actually starting a server
// (dev/preview). For `vite build` we fall back to safe defaults so the
// root `pnpm build` (used by the deployment pipeline before per-artifact
// production env vars are injected) does not crash. The deployment
// runner still sets BASE_PATH=/ and PORT=20853 from
// [services.production.build.env] when building for production.
const isServe = process.argv.includes("dev") || process.argv.includes("serve") || process.argv.includes("preview");

const rawPort = process.env.PORT;

if (isServe && !rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = rawPort ? Number(rawPort) : 0;

if (isServe && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const rawBasePath = process.env.BASE_PATH;

if (isServe && !rawBasePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

const basePath = rawBasePath ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    spaFallbackHtml(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "apple-touch-icon.png"],
      manifest: {
        name: "TradePilot.id",
        short_name: "TradePilot.id",
        description: "Pendukung keputusan trading berbasis AI",
        theme_color: "#1e3a5f",
        background_color: "#ffffff",
        display: "standalone",
        orientation: "any",
        scope: basePath,
        start_url: basePath,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // `offline.html` is already picked up by the `*.html` glob below
        // (with a revision hash). Re-adding it via `additionalManifestEntries`
        // produced a second precache entry for the same URL but with
        // `revision: null`, which trips workbox's "conflicting entries"
        // guard in production and aborts the entire service-worker
        // evaluation — so the install/notifications flow fails with
        // "ServiceWorker script evaluation failed". Letting the glob
        // be the single source of truth keeps one entry per URL.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // `404.html` / `200.html` are byte-for-byte copies of `index.html`
        // emitted only as static-host SPA fallbacks (see `spaFallbackHtml`).
        // No need to precache a third + fourth copy of the app shell.
        globIgnores: ["**/404.html", "**/200.html"],
        // The app shell is just over Workbox's default 2 MiB limit; retain
        // offline/install support while keeping a bounded precache cap.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      // Enable the service worker in dev so push notifications and the
      // install/enable flow can be tested from the Replit preview without
      // running a production build.
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: `${basePath}index.html`,
      },
    }),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
