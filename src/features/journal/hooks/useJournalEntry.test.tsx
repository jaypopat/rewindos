import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// ── In-memory "DB" keyed by date, shared with the api mock ──
const store = vi.hoisted(() => ({ entries: new Map<string, { id: number; content: string }>() }));

vi.mock("@/lib/api", () => {
  let nextId = 1;
  return {
    getJournalEntry: vi.fn(async (date: string) => {
      const e = store.entries.get(date);
      return e ? { id: e.id, date, content: e.content } : null;
    }),
    upsertJournalEntry: vi.fn(async (entry: { date: string; content: string }) => {
      const existing = store.entries.get(entry.date);
      const id = existing?.id ?? nextId++;
      store.entries.set(entry.date, { id, content: entry.content });
      return id;
    }),
    getJournalDates: vi.fn(async () => []),
    getJournalStreak: vi.fn(async () => ({ current: 0, longest: 0 })),
    getJournalScreenshots: vi.fn(async () => []),
    addJournalScreenshot: vi.fn(async () => {}),
    removeJournalScreenshot: vi.fn(async () => {}),
    getActivity: vi.fn(async () => ({ total_screenshots: 0, app_usage: [] })),
    getTaskBreakdown: vi.fn(async () => []),
    getJournalTags: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({ chat: { ollama_url: "" } })),
    getCarryForwardTodos: vi.fn(async () => []),
  };
});

vi.mock("@/lib/ollama-chat", () => ({ ollamaHealth: vi.fn(async () => false) }));
vi.mock("@tanstack/react-hotkeys", () => ({ useHotkey: vi.fn() }));

import { useJournalEntry } from "./useJournalEntry";
import { upsertJournalEntry } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

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

describe("useJournalEntry persistence", () => {
  beforeEach(() => {
    store.entries.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Bug 1: keeps the journalEntry cache in sync after auto-save", async () => {
    const { client, wrapper } = makeWrapper();
    const { result } = renderHook(() => useJournalEntry(), { wrapper });

    // Initial load of today's (empty) entry.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const todayKey = result.current.dateKey;

    // Type something.
    act(() => result.current.setContent("hello"));

    // Let the 800ms debounce fire the auto-save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });

    // The DB got it.
    expect(upsertJournalEntry).toHaveBeenCalledWith({ date: todayKey, content: "hello" });

    // The cache that goToDate() seeds the editor from must also reflect it —
    // otherwise switching away and back shows stale/empty content.
    const cached = client.getQueryData<{ content: string } | null>(
      queryKeys.journalEntry(todayKey),
    );
    expect(cached?.content).toBe("hello");
  });

  it("instant write → switch → switch back: the text is still there", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useJournalEntry(), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const todayKey = result.current.dateKey;

    // Type, then switch away IMMEDIATELY — before the 800ms debounce fires.
    act(() => result.current.setContent("hello"));
    act(() => result.current.goToNext());

    // Let the navigation-flush save + its cache write settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.dateKey).not.toBe(todayKey);

    // Switch back to today.
    act(() => result.current.goToPrev());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(result.current.dateKey).toBe(todayKey);
    expect(result.current.content).toBe("hello");
    expect(store.entries.get(todayKey)?.content).toBe("hello");
  });

  it("Bug 2: a stale debounced save must not write onto the new date", async () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useJournalEntry(), { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const todayKey = result.current.dateKey;

    // Type on today, let it auto-save so debouncedContent === "day-A-text".
    act(() => result.current.setContent("day-A-text"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });

    // Navigate to the next day BEFORE the debounce of any further edit settles.
    act(() => result.current.goToNext());

    // Let the next day's entry query resolve and effects flush, but stay UNDER
    // 800ms so the debounce still holds the previous day's text ("day-A-text").
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const nextKey = result.current.dateKey;
    expect(nextKey).not.toBe(todayKey);

    // The new day must remain empty — day A's text must never land on it.
    const calls = (upsertJournalEntry as ReturnType<typeof vi.fn>).mock.calls;
    const wroteAtextToNextDay = calls.some(
      ([arg]) => arg.date === nextKey && arg.content === "day-A-text",
    );
    expect(wroteAtextToNextDay).toBe(false);
    expect(store.entries.get(nextKey)?.content ?? "").not.toBe("day-A-text");
  });
});
