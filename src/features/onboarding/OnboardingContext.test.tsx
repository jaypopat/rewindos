import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { OnboardingProvider, useOnboarding } from "./OnboardingContext";

const KEY = "rewindos-onboarding-completed";

function wrapper({ children }: { children: React.ReactNode }) {
  return <OnboardingProvider>{children}</OnboardingProvider>;
}

describe("OnboardingContext", () => {
  beforeEach(() => localStorage.clear());

  it("is open on first run (flag unset)", () => {
    const { result } = renderHook(() => useOnboarding(), { wrapper });
    expect(result.current.isOpen).toBe(true);
  });

  it("is closed when the flag is already set", () => {
    localStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useOnboarding(), { wrapper });
    expect(result.current.isOpen).toBe(false);
  });

  it("complete() sets the flag and closes", () => {
    const { result } = renderHook(() => useOnboarding(), { wrapper });
    act(() => result.current.complete());
    expect(result.current.isOpen).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("open() reopens even after completion (flag stays set)", () => {
    localStorage.setItem(KEY, "1");
    const { result } = renderHook(() => useOnboarding(), { wrapper });
    act(() => result.current.open());
    expect(result.current.isOpen).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
  });
});
