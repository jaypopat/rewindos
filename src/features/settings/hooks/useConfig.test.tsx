import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

// ── In-memory "config.toml", shared with the api mock ──
const remote = vi.hoisted(() => ({
  config: { ui: { global_hotkey: "Ctrl+Shift+Space" } } as Record<string, unknown>,
  failNext: false,
}));

vi.mock("@/lib/api", () => ({
  getConfig: vi.fn(async () => remote.config),
  updateConfig: vi.fn(async (c: Record<string, unknown>) => {
    if (remote.failNext) {
      remote.failNext = false;
      throw new Error("disk full");
    }
    remote.config = c;
  }),
}));

import { useConfig } from "./useConfig";
import { updateConfig } from "@/lib/api";
import { analytics } from "@/lib/analytics";

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

// Renders the hook and lets the initial config query resolve.
async function renderLoaded() {
  const { wrapper } = makeWrapper();
  const utils = renderHook(() => useConfig(), { wrapper });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(utils.result.current.config).not.toBeNull();
  return utils;
}

const hotkey = () =>
  (updateConfig as Mock).mock.calls.map(
    (c) => (c[0] as { ui: { global_hotkey: string } }).ui.global_hotkey,
  );

describe("useConfig auto-save", () => {
  beforeEach(() => {
    remote.config = { ui: { global_hotkey: "Ctrl+Shift+Space" }, privacy: { analytics: true } };
    remote.failNext = false;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("coalesces rapid updates into one save after the debounce", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.update("ui", "global_hotkey", "A"));
    act(() => result.current.update("ui", "global_hotkey", "AB"));
    act(() => result.current.update("ui", "global_hotkey", "ABC"));
    expect(updateConfig).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(hotkey()).toEqual(["ABC"]);
  });

  it("saves rapid analytics off/on transitions immediately and in order", async () => {
    const intent = vi.spyOn(analytics, "consentIntent");
    const persisted = vi.spyOn(analytics, "consentPersisted");
    const { result } = await renderLoaded();
    let releaseOff!: () => void;
    vi.mocked(updateConfig).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseOff = resolve; }),
    );

    act(() => {
      result.current.update("privacy", "analytics", false);
      result.current.update("privacy", "analytics", true);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(intent).toHaveBeenCalledTimes(2);
    expect(persisted).not.toHaveBeenCalled();
    expect(vi.mocked(updateConfig).mock.calls.map(([c]) => c.privacy.analytics)).toEqual([false]);

    await act(async () => {
      releaseOff();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.mocked(updateConfig).mock.calls.map(([c]) => c.privacy.analytics)).toEqual([false, true]);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(updateConfig).toHaveBeenCalledTimes(2);
  });

  it("stops capture before a queued off save and never acknowledges a failed consent save", async () => {
    const intent = vi.spyOn(analytics, "consentIntent");
    const persisted = vi.spyOn(analytics, "consentPersisted");
    const { result } = await renderLoaded();
    let release!: () => void;
    vi.mocked(updateConfig).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    act(() => result.current.update("ui", "global_hotkey", "pending"));
    await act(async () => { result.current.flush(); await vi.advanceTimersByTimeAsync(0); });
    act(() => result.current.update("privacy", "analytics", false));
    expect(intent).toHaveBeenCalledTimes(1);
    expect(updateConfig).toHaveBeenCalledTimes(1);
    remote.failNext = true;
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.error).toContain("disk full");
    expect(persisted).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(updateConfig).toHaveBeenCalledTimes(2);
  });

  it("orders analytics transitions behind an in-flight save and preserves newer edits", async () => {
    const { result } = await renderLoaded();
    let releaseSave!: () => void;
    vi.mocked(updateConfig).mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseSave = resolve; }),
    );
    act(() => result.current.update("ui", "global_hotkey", "A"));
    await act(async () => {
      result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => {
      result.current.update("privacy", "analytics", false);
      result.current.update("ui", "global_hotkey", "AB");
      result.current.update("privacy", "analytics", true);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(updateConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseSave();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.mocked(updateConfig).mock.calls.map(([c]) => c.privacy.analytics)).toEqual([true, false, true]);
    expect(hotkey()).toEqual(["A", "A", "AB"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(updateConfig).toHaveBeenCalledTimes(3);
  });

  it("flush() persists immediately without waiting for the debounce", async () => {
    const { result } = await renderLoaded();

    act(() => result.current.update("ui", "global_hotkey", "A"));
    await act(async () => {
      result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(hotkey()).toEqual(["A"]);
  });

  it("does not wipe edits typed while a save is in flight, then saves them", async () => {
    const { result } = await renderLoaded();

    // Make the first save hang until released.
    let release!: () => void;
    (updateConfig as Mock).mockImplementationOnce(
      () => new Promise<void>((res) => (release = res)),
    );

    act(() => result.current.update("ui", "global_hotkey", "A"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800); // save "A" now in flight
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);

    // Type during the in-flight save.
    act(() => result.current.update("ui", "global_hotkey", "AB"));

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0); // first save settles
    });
    // Snapshot guard: newer edits survive the success of the older save.
    expect(
      (result.current.config as { ui: { global_hotkey: string } }).ui.global_hotkey,
    ).toBe("AB");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800); // debounce catches up with "AB"
    });
    expect(updateConfig).toHaveBeenCalledTimes(2);
    expect(hotkey()[1]).toBe("AB");
  });

  it("keeps edits on failure, does not hot-loop, and retries on the next edit", async () => {
    const { result } = await renderLoaded();

    remote.failNext = true;
    act(() => result.current.update("ui", "global_hotkey", "A"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800); // debounce fires, save runs
    });
    // Extra tick so the async mutation rejection propagates through TanStack
    // into React state (the rejection is a microtask that needs a render cycle).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("disk full");
    // Edits survive the failure...
    expect(
      (result.current.config as { ui: { global_hotkey: string } }).ui.global_hotkey,
    ).toBe("A");
    // ...and the failed value is NOT retried automatically.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);

    // The next edit retries (and succeeds).
    act(() => result.current.update("ui", "global_hotkey", "AB"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updateConfig).toHaveBeenCalledTimes(2);
    expect(hotkey()[1]).toBe("AB");
  });

  it("never saves when nothing was edited", async () => {
    await renderLoaded();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("flushes pending edits on unmount", async () => {
    const { result, unmount } = await renderLoaded();

    act(() => result.current.update("ui", "global_hotkey", "A"));
    unmount(); // mid-debounce
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
    expect(hotkey()).toEqual(["A"]);
  });

  it("does not start a second save while one is in flight", async () => {
    const { result } = await renderLoaded();

    // Make the first save hang until released.
    let release!: () => void;
    (updateConfig as Mock).mockImplementationOnce(
      () => new Promise<void>((res) => (release = res)),
    );

    act(() => result.current.update("ui", "global_hotkey", "A"));
    await act(async () => {
      result.current.flush(); // save "A" in flight
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);

    // Debounce catches up while the flush-save is still pending: must NOT
    // fire a concurrent duplicate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Settled with no newer edits: nothing more to save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });
});
