import { afterEach, describe, expect, it, vi } from "vitest";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { analytics, startAnalytics } from "./index";

afterEach(() => { vi.restoreAllMocks(); });

describe("native subscription lifecycle", () => {
  it("ignores events from an unmounted subscription while a replacement is active", async () => {
    let callback: EventCallback<unknown> | undefined;
    let resolve: ((unsubscribe: () => void) => void) | undefined;
    vi.spyOn(analytics, "start").mockReturnValue(vi.fn());
    const event = vi.spyOn(analytics, "nativeEvent");
    vi.mocked(listen).mockImplementationOnce((_name, handler) => {
      callback = handler;
      return new Promise((done) => { resolve = done; });
    });
    const oldStop = startAnalytics();
    oldStop();
    const stop = startAnalytics();
    callback?.({ event: "analytics-action", id: 1, payload: { event: "ask_sent", provider: "ollama" } });
    expect(event).not.toHaveBeenCalled();
    const unsubscribe = vi.fn();
    resolve?.(unsubscribe);
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    stop();
  });
});
