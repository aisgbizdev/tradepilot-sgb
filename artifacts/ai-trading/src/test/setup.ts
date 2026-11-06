import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom does not implement EventSource, but the page-level Layout opens
// an SSE connection to `/api/notifications/stream` as soon as a user is
// loaded. Stub a no-op constructor so component tests rendering through
// `<Layout>` do not crash with `ReferenceError: EventSource is not defined`.
// jsdom does not implement ResizeObserver, but several Radix primitives
// (Checkbox, Popover, Select, …) read element sizes via
// `@radix-ui/react-use-size`. Without a stub the very first render
// throws `ReferenceError: ResizeObserver is not defined` and the test
// fails before it can run a single assertion.
// jsdom does not implement Element.scrollIntoView, but Radix Select
// calls it on the highlighted item every time the listbox opens. Stub
// it to a no-op so tests that drive Select via user-event do not crash.
if (
  typeof Element !== "undefined" &&
  typeof (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView !==
    "function"
) {
  (Element.prototype as { scrollIntoView: () => void }).scrollIntoView =
    function () {};
}

// jsdom does not implement Element.hasPointerCapture / setPointerCapture
// either, both of which Radix Select calls on the trigger when it
// opens. Stub them so user-event keyboard interactions do not throw.
if (
  typeof Element !== "undefined" &&
  typeof (Element.prototype as { hasPointerCapture?: unknown })
    .hasPointerCapture !== "function"
) {
  (Element.prototype as { hasPointerCapture: () => boolean }).hasPointerCapture =
    function () {
      return false;
    };
  (Element.prototype as { setPointerCapture: () => void }).setPointerCapture =
    function () {};
  (Element.prototype as { releasePointerCapture: () => void }).releasePointerCapture =
    function () {};
}

if (typeof globalThis !== "undefined" && typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: StubResizeObserver,
  });
}

if (typeof globalThis !== "undefined" && typeof (globalThis as { EventSource?: unknown }).EventSource === "undefined") {
  class StubEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly url: string;
    readonly readyState = StubEventSource.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    constructor(url: string | URL) {
      this.url = typeof url === "string" ? url : url.toString();
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
    dispatchEvent(): boolean {
      return false;
    }
  }
  Object.defineProperty(globalThis, "EventSource", {
    writable: true,
    configurable: true,
    value: StubEventSource,
  });
}
