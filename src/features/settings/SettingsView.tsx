import { useState } from "react";
import { useConfig } from "./hooks/useConfig";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Settings } from "lucide-react";
import { GeneralTab } from "./tabs/GeneralTab";
import { CaptureTab } from "./tabs/CaptureTab";
import { PrivacyTab } from "./tabs/PrivacyTab";
import { AITab } from "./tabs/AITab";
import { FocusTab } from "./tabs/FocusTab";
import { StorageTab } from "./tabs/StorageTab";
import { OCRTab } from "./tabs/OCRTab";

type Tab = "general" | "capture" | "privacy" | "ai" | "storage" | "ocr" | "focus";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "capture", label: "Capture" },
  { id: "privacy", label: "Privacy" },
  { id: "ai", label: "AI / Models" },
  { id: "focus", label: "Focus" },
  { id: "storage", label: "Storage" },
  { id: "ocr", label: "OCR" },
];

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const { config, saving, saved, error, handleSave, update } = useConfig();

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="font-mono text-xs text-text-muted">
          {error ? `error: ${error}` : "loading config..."}
        </span>
      </div>
    );
  }

  const tabContent = {
    general: <GeneralTab config={config} update={update} />,
    capture: <CaptureTab config={config} update={update} />,
    privacy: <PrivacyTab config={config} update={update} />,
    ai: <AITab config={config} update={update} />,
    focus: <FocusTab config={config} update={update} />,
    storage: <StorageTab config={config} update={update} />,
    ocr: <OCRTab config={config} update={update} />,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="size-4 text-text-muted" strokeWidth={1.8} />
          <span className="font-mono text-xs text-text-muted uppercase tracking-wider">settings</span>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="font-mono text-[10px] text-signal-error">{error}</span>}
          {saved && <span className="font-mono text-[10px] text-signal-active">saved</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 font-mono text-[11px] text-text-primary bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-all disabled:opacity-50 uppercase tracking-wider"
          >
            {saving ? "saving..." : "save"}
          </button>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        <div className="w-36 border-r border-border/50 py-2 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-4 py-1.5 font-mono text-xs transition-all ${
                tab === t.id
                  ? "text-accent bg-accent/5 border-r-2 border-accent"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <ScrollArea className="flex-1">
          <div className="px-6 py-4 max-w-xl space-y-5">
            {tabContent[tab]}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
