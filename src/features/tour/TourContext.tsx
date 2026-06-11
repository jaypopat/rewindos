import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { TOUR_STOPS } from "./tour-stops";

const STORAGE_KEY = "rewindos-tour-seen";

interface TourContextValue {
  active: boolean;
  stepIndex: number;
  start: () => void;
  next: () => void;
  back: () => void;
  end: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const start = useCallback(() => {
    setStepIndex(0);
    setActive(true);
  }, []);

  const end = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "1");
    setActive(false);
  }, []);

  const next = useCallback(() => {
    if (stepIndex >= TOUR_STOPS.length - 1) {
      end();
    } else {
      setStepIndex(stepIndex + 1);
    }
  }, [stepIndex, end]);

  const back = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);

  const value = useMemo(
    () => ({ active, stepIndex, start, next, back, end }),
    [active, stepIndex, start, next, back, end],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error("useTour must be used within TourProvider");
  return ctx;
}
