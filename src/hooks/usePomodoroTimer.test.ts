import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePomodoroTimer } from "./usePomodoroTimer";

const TEST_CONFIG = {
  workMinutes: 1, // 60 seconds for faster tests
  shortBreakMinutes: 1,
  longBreakMinutes: 2,
  sessionsBeforeLongBreak: 2,
  autoStartBreaks: false,
  autoStartWork: false,
};

describe("usePomodoroTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle phase", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.completedSessions).toBe(0);
  });

  it("transitions to work phase on start", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    expect(result.current.state.phase).toBe("work");
    expect(result.current.state.isRunning).toBe(true);
    expect(result.current.state.secondsRemaining).toBe(60);
  });

  it("counts down when running", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(5000); // 5 seconds
    });

    expect(result.current.state.secondsRemaining).toBe(55);
  });

  it("pauses the timer", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    act(() => {
      result.current.pause();
    });

    const remaining = result.current.state.secondsRemaining;
    expect(result.current.state.isRunning).toBe(false);

    // Timer shouldn't move after pause
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.state.secondsRemaining).toBe(remaining);
  });

  it("resets to idle", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.isRunning).toBe(false);
    expect(result.current.state.completedSessions).toBe(0);
    expect(result.current.state.totalWorkSeconds).toBe(0);
  });

  it("tracks total work seconds", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.state.totalWorkSeconds).toBe(10);
  });

  it("calculates progress correctly", () => {
    const { result } = renderHook(() => usePomodoroTimer(TEST_CONFIG));

    act(() => {
      result.current.start();
    });

    expect(result.current.state.totalSeconds).toBe(60);
    expect(result.current.state.secondsRemaining).toBe(60);

    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(result.current.state.secondsRemaining).toBe(30);
  });
});
