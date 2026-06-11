import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { TourProvider, useTour } from "./TourContext";
import { TourOverlay } from "./TourOverlay";
import { TOUR_STOPS } from "./tour-stops";

const navigateSpy = vi.fn();

// Capture the latest Escape callback registered via useHotkey so we can
// invoke it directly — the singleton HotkeyManager doesn't fire reliably
// in JSDOM. This matches the pattern used in useJournalEntry.test.tsx.
const hotkeyCallbacks = new Map<string, () => void>();
vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkey: vi.fn((key: string, cb: () => void) => {
    hotkeyCallbacks.set(key, cb);
  }),
}));

function Starter({ autoStart }: { autoStart: boolean }) {
  const { start } = useTour();
  useEffect(() => {
    if (autoStart) start();
  }, [autoStart, start]);
  return null;
}

function Harness({ autoStart = true }: { autoStart?: boolean }) {
  return (
    <TourProvider>
      <Starter autoStart={autoStart} />
      <TourOverlay onNavigate={navigateSpy} />
    </TourProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  navigateSpy.mockClear();
  hotkeyCallbacks.clear();
});

afterEach(() => {
  document.querySelectorAll("[data-tour]").forEach((el) => el.remove());
});

describe("TourOverlay", () => {
  it("renders nothing when the tour is inactive", () => {
    render(<Harness autoStart={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates to the first stop's view and shows its card when the anchor exists", async () => {
    const anchor = document.createElement("div");
    anchor.setAttribute("data-tour", TOUR_STOPS[0].anchor);
    document.body.appendChild(anchor);

    render(<Harness />);
    expect(navigateSpy).toHaveBeenCalledWith(TOUR_STOPS[0].view);
    expect(await screen.findByText(TOUR_STOPS[0].title)).toBeTruthy();
  });

  it("falls back to a centered card when the anchor never appears", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    render(<Harness />);
    await act(async () => {
      // Run all rAF callbacks past ANCHOR_TIMEOUT_MS (1500 ms)
      vi.advanceTimersByTime(2000);
      vi.runAllTimers();
    });
    vi.useRealTimers();
    expect(await screen.findByText(TOUR_STOPS[0].title)).toBeTruthy();
  });

  it("Escape ends the tour", async () => {
    const anchor = document.createElement("div");
    anchor.setAttribute("data-tour", TOUR_STOPS[0].anchor);
    document.body.appendChild(anchor);

    render(<Harness />);
    await screen.findByText(TOUR_STOPS[0].title);

    // Invoke the Escape callback registered via useHotkey
    act(() => {
      hotkeyCallbacks.get("Escape")?.();
    });

    expect(screen.queryByText(TOUR_STOPS[0].title)).toBeNull();
    expect(localStorage.getItem("rewindos-tour-seen")).toBe("1");
  });
});
