import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHotkey } from "@tanstack/react-hotkeys";
import {
  getDaemonStatus,
  openExtensionPage,
  recheckWindowInfo,
  resumeCapture,
  setUnfilteredCapture,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOnboarding } from "./OnboardingContext";
import { deriveCaptureVerdict, type VerdictAction } from "./deriveCaptureVerdict";
import { WizardShell } from "./WizardShell";
import { WelcomeStep } from "./steps/WelcomeStep";
import { CaptureStep } from "./steps/CaptureStep";
import { PrivacyStep } from "./steps/PrivacyStep";
import { FinishStep } from "./steps/FinishStep";

const STEPS = ["welcome", "capture", "privacy", "finish"] as const;

// Thin gate: WizardBody only mounts while open, so its step state resets
// naturally on reopen (no manual reset needed), and its status poll stops
// when closed (the body unmounts → query observer is torn down).
export function FirstRunWizard() {
  const { isOpen } = useOnboarding();
  if (!isOpen) return null;
  return <WizardBody />;
}

function WizardBody() {
  const { complete } = useOnboarding();
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const { data: status, isError } = useQuery({
    queryKey: queryKeys.daemonStatus(),
    queryFn: getDaemonStatus,
    refetchInterval: 2000,
    retry: false,
  });

  const verdict = deriveCaptureVerdict(status, isError);

  const onAction = useCallback(
    async (a: VerdictAction) => {
      setBusy(true);
      try {
        if (a === "resume") await resumeCapture();
        else if (a === "install-extension") await openExtensionPage();
        else if (a === "recheck") await recheckWindowInfo();
        else if (a === "capture-anyway") await setUnfilteredCapture(true);
        await qc.invalidateQueries({ queryKey: queryKeys.daemonStatus() });
      } catch {
        // Non-blocking: surfaced via the next status poll; never traps the user.
      } finally {
        setBusy(false);
      }
    },
    [qc],
  );

  const isLast = stepIndex === STEPS.length - 1;
  const onNext = useCallback(() => {
    if (isLast) complete();
    else setStepIndex((i) => i + 1);
  }, [isLast, complete]);
  const onBack = useCallback(() => setStepIndex((i) => Math.max(0, i - 1)), []);

  // Esc skips — matches the app's overlay convention (ConfirmDialog,
  // JournalSearchPanel). Enter advances only via the focused Next button's own
  // click (no global Enter binding) so a step is never double-advanced.
  useHotkey("Escape", () => complete());

  const step = STEPS[stepIndex];
  const nextLabel =
    isLast ? "Done" : step === "capture" ? (verdict.level === "green" ? "Next" : "Continue anyway") : "Next";

  return (
    <WizardShell
      stepIndex={stepIndex}
      stepCount={STEPS.length}
      canBack={stepIndex > 0}
      nextLabel={nextLabel}
      onBack={onBack}
      onNext={onNext}
      onSkip={complete}
    >
      {step === "welcome" && <WelcomeStep />}
      {step === "capture" && <CaptureStep verdict={verdict} onAction={(a) => void onAction(a)} busy={busy} />}
      {step === "privacy" && <PrivacyStep />}
      {step === "finish" && <FinishStep verdict={verdict} />}
    </WizardShell>
  );
}
