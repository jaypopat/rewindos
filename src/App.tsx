import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SearchFilters } from "@/lib/api";
import { useDebounce } from "@/hooks/useDebounce";
import { Sidebar, type View } from "@/components/Sidebar";
import { SearchBar, DATE_PRESETS } from "@/components/SearchBar";
import { SearchResults } from "@/components/SearchResults";
import { ScreenshotDetail } from "@/components/ScreenshotDetail";
import { DashboardView } from "@/components/DashboardView";
import { HistoryView } from "@/components/HistoryView";
import { DaemonPanel } from "@/components/DaemonPanel";
import { AskView } from "@/components/AskView";
import { SettingsView } from "@/components/SettingsView";
import { FocusView } from "@/components/FocusView";

type SubView = "list" | "detail";

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [subView, setSubView] = useState<SubView>("list");
  const [selectedScreenshotId, setSelectedScreenshotId] = useState<number | null>(null);
  const [screenshotIds, setScreenshotIds] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string | undefined>();
  const [datePreset, setDatePreset] = useState(0);
  const [resultView, setResultView] = useState<"grid" | "list">("grid");

  const searchInputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounce(query, 300);

  const datePresetDef = DATE_PRESETS[datePreset];
  const startTime = datePresetDef.value ? datePresetDef.value() : undefined;

  const filters: SearchFilters = {
    start_time: startTime,
    end_time: undefined,
    app_name: appFilter,
    limit: 50,
    offset: 0,
  };

  const handleSelectResult = useCallback((id: number, siblingIds?: number[]) => {
    setSelectedScreenshotId(id);
    setScreenshotIds(siblingIds ?? []);
    setSubView("detail");
  }, []);

  const handleNavigateScreenshot = useCallback((id: number) => {
    setSelectedScreenshotId(id);
  }, []);

  const handleBack = useCallback(() => {
    setSubView("list");
    setSelectedScreenshotId(null);
    setScreenshotIds([]);
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const handleViewChange = useCallback((v: View) => {
    setView(v);
    setSubView("list");
    setSelectedScreenshotId(null);
    if (v === "search") {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !isInputFocused()) {
        e.preventDefault();
        handleViewChange("search");
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === "Escape" && subView === "detail") {
        handleBack();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [subView, handleBack, handleViewChange]);

  // Listen for global hotkey (Ctrl+Shift+Space)
  useEffect(() => {
    const unlisten = listen("focus-search", () => {
      handleViewChange("search");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleViewChange]);

  return (
    <main className="flex h-screen animate-fade-in">
      <Sidebar activeView={view} onViewChange={handleViewChange} />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar — daemon status only, no title duplication */}
        <header className="flex items-center justify-end px-5 py-2 border-b border-border/50 bg-surface/80 backdrop-blur-sm shrink-0">
          <DaemonPanel />
        </header>

        {/* Content */}
        {view === "search" && subView === "list" && (
          <div className="flex-1 flex flex-col min-h-0">
            <SearchBar
              ref={searchInputRef}
              query={query}
              onQueryChange={setQuery}
              appFilter={appFilter}
              onAppFilterChange={setAppFilter}
              datePreset={datePreset}
              onDatePresetChange={setDatePreset}
            />
            <SearchResults
              query={debouncedQuery}
              filters={filters}
              onSelectResult={handleSelectResult}
              resultView={resultView}
              onResultViewChange={setResultView}
            />
          </div>
        )}

        {(view === "search" || view === "dashboard" || view === "history" || view === "ask") && subView === "detail" && selectedScreenshotId !== null && (
          <ScreenshotDetail
            screenshotId={selectedScreenshotId}
            onBack={handleBack}
            searchQuery={debouncedQuery}
            screenshotIds={screenshotIds}
            onNavigate={handleNavigateScreenshot}
          />
        )}

        {view === "dashboard" && subView === "list" && (
          <DashboardView onSelectScreenshot={handleSelectResult} />
        )}

        {view === "history" && subView === "list" && (
          <HistoryView onSelectScreenshot={handleSelectResult} />
        )}

        {view === "ask" && subView === "list" && (
          <AskView onSelectScreenshot={handleSelectResult} />
        )}

        {view === "focus" && (
          <FocusView />
        )}

        {view === "settings" && (
          <SettingsView />
        )}
      </div>
    </main>
  );
}

function isInputFocused(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

export default App;
