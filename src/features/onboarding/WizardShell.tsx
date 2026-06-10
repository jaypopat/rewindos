import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface WizardShellProps {
  stepIndex: number;
  stepCount: number;
  canBack: boolean;
  nextLabel: string;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
  children: ReactNode;
}

export function WizardShell({
  stepIndex, stepCount, canBack, nextLabel, onBack, onNext, onSkip, children,
}: WizardShellProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm animate-in fade-in duration-300 ease-quiet">
      <div className="relative flex w-full max-w-xl flex-col gap-6 rounded-lg border border-border/60 bg-surface p-8 shadow-2xl">
        <button
          onClick={onSkip}
          className="absolute right-4 top-4 font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary transition-colors"
          aria-label="Skip setup"
        >
          Skip
        </button>

        <div className="flex items-center gap-1.5" aria-hidden>
          {Array.from({ length: stepCount }).map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= stepIndex ? "bg-accent" : "bg-border/60"
              }`}
            />
          ))}
        </div>

        <div className="min-h-[18rem]">{children}</div>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={!canBack}>
            Back
          </Button>
          <Button size="sm" onClick={onNext}>
            {nextLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
