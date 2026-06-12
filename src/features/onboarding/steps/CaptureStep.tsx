import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import type { CaptureVerdict, VerdictAction, VerdictLevel } from "../deriveCaptureVerdict";

const LEVEL_DOT: Record<VerdictLevel, string> = {
  green: "bg-signal-active",
  amber: "bg-signal-paused",
  red: "bg-signal-error",
  neutral: "bg-text-muted",
};

const ACTION_LABEL: Record<VerdictAction, string> = {
  retry: "Retry",
  resume: "Resume capture",
  "install-extension": "Install extension",
  recheck: "Re-check",
  "capture-anyway": "Capture anyway",
};

interface CaptureStepProps {
  verdict: CaptureVerdict;
  onAction: (a: VerdictAction) => void;
  busy: boolean;
}

export function CaptureStep({ verdict, onAction, busy }: CaptureStepProps) {
  const showSpinner = verdict.code === "checking" || verdict.code === "waiting";
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-text-primary">Is capture working?</h2>

      <div className="flex items-start gap-3 rounded-md border border-border/50 bg-background/40 p-4">
        {showSpinner ? (
          <Spinner className="mt-0.5 size-4 text-signal-paused" />
        ) : (
          <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${LEVEL_DOT[verdict.level]}`} aria-hidden />
        )}
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text-primary">{verdict.headline}</p>
          {verdict.level === "green" && (
            <p className="text-xs text-text-muted">{verdict.framesToday} frames captured today</p>
          )}
          {verdict.guidance && (
            <p className="whitespace-pre-line text-xs leading-relaxed text-text-secondary">{verdict.guidance}</p>
          )}
        </div>
      </div>

      {verdict.actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {verdict.actions.map((a) => (
            <Button
              key={a}
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => onAction(a)}
            >
              {ACTION_LABEL[a]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
