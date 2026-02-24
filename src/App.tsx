import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { SearchFilters } from "@/lib/api";
import { useDebounce } from "@/hooks/useDebounce";
import { useGlobalKeyboard } from "@/hooks/useGlobalKeyboard";
import { Sidebar, type View } from "@/components/Sidebar";
import { SearchBar, DATE_PRESETS } from "@/components/SearchBar";
import { SearchResults } from "@/components/SearchResults";
import { DaemonPanel } from "@/components/DaemonPanel";
import {
  DashboardView,
  HistoryView,
  RewindView,
  AskView,
  SavedView,
  JournalView,
  FocusView,
  SettingsView,
  ScreenshotDetail,
  ViewSuspense,
} from "@/app/routes";

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

  const filters: SearchFilters = useMemo(
    () => ({
      start_time: startTime,
      end_time: undefined,
      app_name: appFilter,
      limit: 50,
      offset: 0,
    }),
    [startTime, appFilter],
  );

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
  useGlobalKeyboard({
    onSearch: useCallback(() => {
      handleViewChange("search");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }, [handleViewChange]),
    onEscape: handleBack,
    isDetailView: subView === "detail",
  });

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

  const showDetail =
    (view === "search" || view === "dashboard" || view === "history" || view === "rewind" || view === "ask" || view === "saved" || view === "journal") &&
    subView === "detail" &&
    selectedScreenshotId !== null;

  return (
    <main className="flex h-screen animate-fade-in">
      <Sidebar activeView={view} onViewChange={handleViewChange} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-end px-5 py-2 border-b border-border/50 bg-surface/80 backdrop-blur-sm shrink-0">
          <DaemonPanel />
        </header>

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

        {view === "rewind" && subView === "list" && (
          <ViewSuspense>
            <RewindView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {showDetail && (
          <ViewSuspense>
            <ScreenshotDetail
              screenshotId={selectedScreenshotId!}
              onBack={handleBack}
              searchQuery={debouncedQuery}
              screenshotIds={screenshotIds}
              onNavigate={handleNavigateScreenshot}
            />
          </ViewSuspense>
        )}

        {view === "dashboard" && subView === "list" && (
          <DashboardView onSelectScreenshot={handleSelectResult} />
        )}

        {view === "history" && subView === "list" && (
          <ViewSuspense>
            <HistoryView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {view === "ask" && subView === "list" && (
          <ViewSuspense>
            <AskView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {view === "saved" && subView === "list" && (
          <ViewSuspense>
            <SavedView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {view === "journal" && subView === "list" && (
          <ViewSuspense>
            <JournalView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {view === "focus" && (
          <ViewSuspense>
            <FocusView />
          </ViewSuspense>
        )}

        {view === "settings" && (
          <ViewSuspense>
            <SettingsView />
          </ViewSuspense>
        )}
      </div>
    </main>
  );
}

export default App;
