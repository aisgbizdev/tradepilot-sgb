import { useCallback } from "react";

// API base URL is the Vite-injected base path. Mirrors the convention used
// elsewhere in this app (BASE_URL is always trailing-slashed).
const API_PATH = `${import.meta.env.BASE_URL}api/events/track`;

// Fire-and-forget analytics ping — same rationale as useTrackOutbound
// (see use-track-outbound.ts): `navigator.sendBeacon` survives navigation/
// backgrounding, which a plain `fetch` does not guarantee, and that's
// exactly when a page-view or "user just navigated away" action fires.
// `fetch` with `keepalive: true` is the documented fallback. Errors are
// swallowed end-to-end — analytics must never crash the UI.
function sendBeaconPayload(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(API_PATH, blob)) return;
    }
  } catch {
    /* fall through to keepalive fetch */
  }
  try {
    void fetch(API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    /* swallow */
  }
}

export type AnalyticsEventType =
  | "page_view"
  | "analysis_created"
  | "trade_logged"
  | "alert_armed"
  | "feedback_submitted";

export function useTrackEvent() {
  return useCallback((eventType: AnalyticsEventType, metadata?: Record<string, unknown>) => {
    sendBeaconPayload({
      eventType,
      path: typeof window !== "undefined" ? window.location.pathname : undefined,
      metadata,
    });
  }, []);
}
