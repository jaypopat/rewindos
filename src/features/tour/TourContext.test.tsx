import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { TourProvider, useTour } from "./TourContext";
import { TOUR_STOPS } from "./tour-stops";

const wrapper = ({ children }: { children: ReactNode }) => (
  <TourProvider>{children}</TourProvider>
);

beforeEach(() => localStorage.clear());

describe("TourContext", () => {
  it("starts inactive; start() activates at step 0", () => {
    const { result } = renderHook(() => useTour(), { wrapper });
    expect(result.current.active).toBe(false);
    act(() => result.current.start());
    expect(result.current.active).toBe(true);
    expect(result.current.stepIndex).toBe(0);
  });

  it("next advances, back clamps at 0", () => {
    const { result } = renderHook(() => useTour(), { wrapper });
    act(() => result.current.start());
    act(() => result.current.next());
    expect(result.current.stepIndex).toBe(1);
    act(() => result.current.back());
    act(() => result.current.back());
    expect(result.current.stepIndex).toBe(0);
  });

  it("next on the last stop ends the tour and persists the seen flag", () => {
    const { result } = renderHook(() => useTour(), { wrapper });
    act(() => result.current.start());
    for (let i = 0; i < TOUR_STOPS.length - 1; i++) {
      act(() => result.current.next());
    }
    expect(result.current.active).toBe(true);
    act(() => result.current.next());
    expect(result.current.active).toBe(false);
    expect(localStorage.getItem("rewindos-tour-seen")).toBe("1");
  });

  it("end() persists the flag; restart resets to step 0 despite the flag", () => {
    const { result } = renderHook(() => useTour(), { wrapper });
    act(() => result.current.start());
    act(() => result.current.next());
    act(() => result.current.end());
    expect(localStorage.getItem("rewindos-tour-seen")).toBe("1");
    act(() => result.current.start());
    expect(result.current.active).toBe(true);
    expect(result.current.stepIndex).toBe(0);
  });
});
