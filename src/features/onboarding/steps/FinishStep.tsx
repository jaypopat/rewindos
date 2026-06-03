import type { CaptureVerdict, VerdictCode } from "../deriveCaptureVerdict";

const CLOSING: Record<VerdictCode, string> = {
  working: "You're all set — capture is working.",
  unfiltered:
    "You're set — but note capture is running unfiltered; app and incognito exclusions aren't being enforced.",
  "gnome-degraded":
    "You're set, but app tracking is off until you install the 'Window Calls Extended' extension.",
  "paused-privacy":
    "You're set, but capture is paused until app tracking can be enforced — install the extension or capture anyway.",
  offline:
    "Almost there — the capture daemon isn't running yet. The status banner will keep nagging until it is.",
  stalled:
    "Almost there — capture isn't producing frames yet. The status banner will keep nagging until it is.",
  "paused-user": "You're set — capture is paused; resume it whenever you're ready.",
  "paused-locked": "You're set — capture will run whenever your session is unlocked.",
  waiting: "You're set — RewindOS is waiting for its first frame.",
  checking: "You're set — finishing the first capture check.",
  unknown: "You're set.",
};

interface FinishStepProps {
  verdict: CaptureVerdict;
}

export function FinishStep({ verdict }: FinishStepProps) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-text-primary">You're ready</h2>
      <p className="text-sm leading-relaxed text-text-secondary">{CLOSING[verdict.code]}</p>

      <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-background/40 p-4 text-sm text-text-secondary">
        <p>
          Press{" "}
          <kbd className="rounded border border-border/60 bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-primary">
            Ctrl+Shift+Space
          </kbd>{" "}
          anytime to search everything you've seen.
        </p>
        <p className="text-xs text-text-muted">
          RewindOS lives in your system tray. Open Settings from there to tune capture,
          privacy, and AI features.
        </p>
      </div>
    </div>
  );
}
