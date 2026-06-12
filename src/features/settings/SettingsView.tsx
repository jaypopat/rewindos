import { useState, useEffect } from "react";
import { useConfig } from "./hooks/useConfig";
import { getDaemonStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTour } from "@/features/tour/TourContext";
import { TOUR_STOPS } from "@/features/tour/tour-stops";
import { GeneralTab } from "./tabs/GeneralTab";
import { CaptureTab } from "./tabs/CaptureTab";
import { PrivacyTab } from "./tabs/PrivacyTab";
import { AITab } from "./tabs/AITab";
import { MeetingTab } from "./tabs/MeetingTab";
import { FocusTab } from "./tabs/FocusTab";
import { StorageTab } from "./tabs/StorageTab";
import { OCRTab } from "./tabs/OCRTab";
import { ExportTab } from "./tabs/ExportTab";

type Tab = "general" | "capture" | "privacy" | "ai" | "meeting" | "storage" | "ocr" | "focus" | "export";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "capture", label: "Capture" },
  { id: "privacy", label: "Privacy" },
  { id: "ai", label: "AI / Models" },
  { id: "meeting", label: "Meetings" },
  { id: "focus", label: "Focus" },
  { id: "storage", label: "Storage" },
  { id: "ocr", label: "OCR" },
  { id: "export", label: "Export" },
];

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const { config, saving, saved, error, flush, update } = useConfig();

  const { active: tourActive, stepIndex: tourStep } = useTour();
  useEffect(() => {
    if (!tourActive) return;
    const settingsTab = TOUR_STOPS[tourStep]?.settingsTab;
    if (settingsTab) setTab(settingsTab);
  }, [tourActive, tourStep]);

  const [desktop, setDesktop] = useState<string | null>(null);
  useEffect(() => {
    getDaemonStatus()
      .then((s) => setDesktop(s.desktop ?? null))
      .catch(() => setDesktop(null));
  }, []);

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="font-mono text-xs text-text-muted">
          {error ? `error: ${error}` : "loading config…"}
        </span>
      </div>
    );
  }

  const tabContent = {
    general: <GeneralTab config={config} update={update} />,
    capture: <CaptureTab config={config} update={update} desktop={desktop} />,
    privacy: <PrivacyTab config={config} update={update} />,
    ai: <AITab config={config} update={update} />,
    meeting: <MeetingTab config={config} update={update} />,
    focus: <FocusTab config={config} update={update} />,
    storage: <StorageTab config={config} update={update} />,
    ocr: <OCRTab config={config} update={update} />,
    export: <ExportTab config={config} update={update} />,
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="px-14 pt-11 pb-24 max-w-[1100px] mx-auto w-full">
        {/* Header */}
        <div className="flex items-end gap-6 pb-8 border-b border-line">
          <div>
            <div className="kicker mb-3">Settings</div>
            <h1 className="font-display text-[34px] leading-tight tracking-tight">
              Tune how RewindOS remembers.
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-3 pb-1">
            {error && (
              <span className="font-mono text-[10.5px] text-signal-error">{error}</span>
            )}
            {saving && (
              <span className="font-mono text-[10.5px] text-text-muted">saving…</span>
            )}
            {saved && !saving && (
              <span className="font-mono text-[10.5px] text-signal-active">saved</span>
            )}
          </div>
        </div>

        <div className="flex gap-12 mt-9" onBlur={flush}>
          {/* Tab rail */}
          <div className="w-[180px] shrink-0 sticky top-6 self-start">
            {TABS.map((t) => (
              <Button
                key={t.id}
                variant="ghost"
                onClick={() => setTab(t.id)}
                className={cn(
                  "w-full justify-start text-left px-3 py-2 h-auto rounded-[7px] text-[13.5px] font-[450] transition-colors",
                  tab === t.id
                    ? "bg-accent-muted text-accent-hi"
                    : "text-text-secondary hover:text-text-primary hover:bg-panel",
                )}
              >
                {t.label}
              </Button>
            ))}
          </div>

          {/* Fields */}
          <div className="flex-1 min-w-0 max-w-[640px]">{tabContent[tab]}</div>
        </div>
      </div>
    </div>
  );
}
