import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { SaveMomentDialog } from "@/features/saved/SaveMomentDialog";
import { Clock } from "lucide-react";

type SubView = "list" | "detail";

interface NavState {
  view: View;
  subView: SubView;
  selectedScreenshotId: number | null;
  screenshotIds: number[];
  rewindTimeRange: { start: number; end: number } | null;
  selectedCollectionId: number | null;
}

type NavAction =
  | { type: "SELECT_RESULT"; id: number; siblingIds?: number[] }
  | { type: "NAVIGATE_SCREENSHOT"; id: number }
  | { type: "GO_BACK" }
  | { type: "CHANGE_VIEW"; view: View }
  | { type: "REWIND_TO_RANGE"; start: number; end: number }
  | { type: "CLEAR_REWIND_RANGE" }
  | { type: "SELECT_COLLECTION"; id: number | null };

function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "SELECT_RESULT":
      return { ...state, selectedScreenshotId: action.id, screenshotIds: action.siblingIds ?? [], subView: "detail" };
    case "NAVIGATE_SCREENSHOT":
      return { ...state, selectedScreenshotId: action.id };
    case "GO_BACK":
      return { ...state, subView: "list", selectedScreenshotId: null, screenshotIds: [] };
    case "CHANGE_VIEW":
      return { ...state, view: action.view, subView: "list", selectedScreenshotId: null, rewindTimeRange: null, selectedCollectionId: null };
    case "REWIND_TO_RANGE":
      return { ...state, rewindTimeRange: { start: action.start, end: action.end }, view: "rewind", subView: "list", selectedScreenshotId: null, selectedCollectionId: null };
    case "CLEAR_REWIND_RANGE":
      return { ...state, rewindTimeRange: null };
    case "SELECT_COLLECTION":
      return { ...state, selectedCollectionId: action.id };
  }
}

const initialNavState: NavState = {
  view: "dashboard",
  subView: "list",
  selectedScreenshotId: null,
  screenshotIds: [],
  rewindTimeRange: null,
  selectedCollectionId: null,
};

function App() {
  const [nav, dispatch] = useReducer(navReducer, initialNavState);
  const { view, subView, selectedScreenshotId, screenshotIds, rewindTimeRange } = nav;

  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string | undefined>();
  const [datePreset, setDatePreset] = useState(0);
  const [resultView, setResultView] = useState<"grid" | "list">("grid");
  const [showSaveMoment, setShowSaveMoment] = useState(false);

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
    dispatch({ type: "SELECT_RESULT", id, siblingIds });
  }, []);

  const handleNavigateScreenshot = useCallback((id: number) => {
    dispatch({ type: "NAVIGATE_SCREENSHOT", id });
  }, []);

  const handleBack = useCallback(() => {
    dispatch({ type: "GO_BACK" });
    setTimeout(() => searchInputRef.current?.focus(), 100);
  }, []);

  const handleViewChange = useCallback((v: View) => {
    dispatch({ type: "CHANGE_VIEW", view: v });
    if (v === "search") {
      setTimeout(() => searchInputRef.current?.focus(), 100);
    }
  }, []);

  const handleRewindToRange = useCallback((start: number, end: number) => {
    dispatch({ type: "REWIND_TO_RANGE", start, end });
  }, []);

  const handleSelectCollection = useCallback((id: number | null) => {
    dispatch({ type: "SELECT_COLLECTION", id });
  }, []);

  const handleEscape = useCallback(() => {
    if (subView === "detail") {
      dispatch({ type: "GO_BACK" });
      setTimeout(() => searchInputRef.current?.focus(), 100);
    } else if (view === "saved" && nav.selectedCollectionId !== null) {
      dispatch({ type: "SELECT_COLLECTION", id: null });
    }
  }, [subView, view, nav.selectedCollectionId]);

  // Global keyboard shortcuts
  useGlobalKeyboard({
    onSearch: useCallback(() => {
      handleViewChange("search");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }, [handleViewChange]),
    onEscape: handleEscape,
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

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="flex items-center justify-end gap-2 px-5 py-2 border-b border-border/50 bg-surface/80 backdrop-blur-sm shrink-0">
          <button
            onClick={() => setShowSaveMoment(true)}
            className="p-1.5 text-text-muted hover:text-accent transition-colors rounded-md hover:bg-accent/10"
            title="Save moment"
          >
            <Clock className="size-4" strokeWidth={1.5} />
          </button>
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
            <RewindView
              key={rewindTimeRange ? `${rewindTimeRange.start}-${rewindTimeRange.end}` : "default"}
              onSelectScreenshot={handleSelectResult}
              initialTimeRange={rewindTimeRange}
              onClearInitialRange={() => dispatch({ type: "CLEAR_REWIND_RANGE" })}
            />
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
            <HistoryView onSelectScreenshot={handleSelectResult} onRewindToRange={handleRewindToRange} />
          </ViewSuspense>
        )}

        {view === "ask" && subView === "list" && (
          <ViewSuspense>
            <AskView onSelectScreenshot={handleSelectResult} />
          </ViewSuspense>
        )}

        {view === "saved" && subView === "list" && (
          <ViewSuspense>
            <SavedView
              onSelectScreenshot={handleSelectResult}
              onRewindToRange={handleRewindToRange}
              selectedCollectionId={nav.selectedCollectionId}
              onSelectCollection={handleSelectCollection}
            />
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

      {showSaveMoment && <SaveMomentDialog onClose={() => setShowSaveMoment(false)} />}
    </main>
  );
}

export default App;
