import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "rewindos-onboarding-completed";

interface OnboardingContextValue {
  isOpen: boolean;
  open: () => void;
  complete: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState<boolean>(
    () => localStorage.getItem(STORAGE_KEY) !== "1",
  );

  const open = useCallback(() => setIsOpen(true), []);
  const complete = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "1");
    setIsOpen(false);
  }, []);

  const value = useMemo(() => ({ isOpen, open, complete }), [isOpen, open, complete]);

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within OnboardingProvider");
  return ctx;
}
