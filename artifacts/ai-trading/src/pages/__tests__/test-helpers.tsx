/**
 * Shared test helpers for the page-level component tests under
 * `artifacts/ai-trading/src/pages/__tests__/*`.
 *
 * The page components (`analyze`, `history`, `notifications`, …) all
 * render inside `<Layout>` which itself depends on `AuthProvider`
 * (`/api/auth/me`) and a recurring `useGetNotifications({ unreadOnly:
 * true })` query. Centralising the wrapper + the default route handlers
 * keeps the individual test files focused on the component being
 * exercised rather than on plumbing.
 *
 * `installFetchMock` is **strict by default**: any fetch URL that is
 * not matched by a handler triggers an immediate rejected promise *and*
 * fails the surrounding test in `afterEach`. The combination is
 * deliberate — the rejection surfaces the failure inside the test if it
 * blocks UI assertions, and the `afterEach` re-throw guarantees the
 * test still fails even when the rejection is swallowed by react-query
 * (e.g. mutations that ignore network errors). Pass `{ strict: false }`
 * to opt out for tests that intentionally fire-and-forget background
 * pollers without registering handlers for them.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { AuthProvider } from "@/components/auth-provider";
import { LanguageProvider } from "@/lib/i18n";

export const TEST_USER = {
  id: 1,
  email: "test@example.com",
  displayName: "Test Trader",
  role: "user",
  selectedMode: "beginner",
  themePreference: "system",
  onboardingCompleted: true,
  createdAt: "2026-01-01T00:00:00Z",
};

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response> | null | undefined;

export interface InstallFetchMockOpts {
  /**
   * When true (the default), unhandled fetches throw an Error with the
   * URL + method and the surrounding test fails via `afterEach`. Set to
   * false to fall back to the legacy behaviour of returning a 404
   * response for unmatched routes.
   */
  strict?: boolean;
}

/**
 * Install a `globalThis.fetch` spy that walks the supplied handlers in
 * order. The first handler returning a non-null `Response` wins. Built-in
 * handlers cover the auth + layout-notifications endpoints so individual
 * tests only need to declare the routes specific to the page under test.
 */
export function installFetchMock(
  extraHandlers: FetchHandler[] = [],
  opts: InstallFetchMockOpts = {},
) {
  const strict = opts.strict !== false;
  let currentUser = { ...TEST_USER };
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const unhandled: Array<{ url: string; method: string }> = [];
  const handlers: FetchHandler[] = [
    ...extraHandlers,
    // Default auth: a logged-in beginner-mode user.
    (url) => {
      if (url.includes("/api/auth/me")) {
        return jsonResponse(currentUser);
      }
      return null;
    },
    (url, init) => {
      if (url.includes("/api/auth/profile") && (init?.method ?? "GET").toUpperCase() === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        currentUser = { ...currentUser, ...body };
        return jsonResponse(currentUser);
      }
      return null;
    },
    (url, init) => {
      if (url.includes("/api/events/track")) {
        return jsonResponse({ success: true });
      }
      return null;
    },
    // Default layout bell query: zero unread notifications.
    (url) => {
      if (url.includes("/api/notifications") && url.includes("unreadOnly=true")) {
        return jsonResponse({ notifications: [], total: 0 });
      }
      return null;
    },
  ];

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      calls.push({ url, method, body });
      for (const handler of handlers) {
        const result = await handler(url, init);
        if (result) return result;
      }
      const msg = `Unhandled fetch in test: ${method} ${url}`;
      if (strict) {
        unhandled.push({ url, method });
        // Surface the failure immediately for fast debugging when a
        // tester runs vitest in watch mode and skims the console.
        // eslint-disable-next-line no-console
        console.error(msg);
        throw new Error(msg);
      }
      return new Response(`unhandled: ${method} ${url}`, { status: 404 });
    },
  );

  if (strict) {
    afterEach(() => {
      if (unhandled.length === 0) return;
      const list = unhandled
        .map((u, i) => `  ${i + 1}. ${u.method} ${u.url}`)
        .join("\n");
      // Reset the buffer so a single failure does not cascade into the
      // next test (the spy is restored by the global setup `afterEach`,
      // but this `afterEach` runs first).
      unhandled.length = 0;
      throw new Error(
        `installFetchMock: ${list.split("\n").length} unhandled fetch ` +
          `call(s) during this test:\n${list}\n` +
          `Add an explicit handler for each route, or pass ` +
          `{ strict: false } to installFetchMock to opt out.`,
      );
    });
  }

  return { spy, calls, unhandled };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme="dark" storageKey="test-theme">
          <LanguageProvider>
            <AuthProvider>{children}</AuthProvider>
          </LanguageProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, queryClient };
}
