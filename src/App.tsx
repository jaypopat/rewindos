import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useHotkey, useHotkeySequences, type HotkeySequence } from "@tanstack/react-hotkeys";
import type { SearchFilters } from "@/lib/api";
import { useDebounce } from "@/hooks/useDebounce";
import { useGlobalKeyboard } from "@/hooks/useGlobalKeyboard";
import { Sidebar, type View } from "@/components/Sidebar";
import { SearchBar } from "@/components/SearchBar";
import { DATE_PRESETS } from "@/lib/date-presets";
import { SearchResults } from "@/components/SearchResults";
import { DaemonPanel } from "@/components/DaemonPanel";
import { GnomeExtensionBanner } from "@/components/GnomeExtensionBanner";
import { UnfilteredWarningBanner } from "@/components/UnfilteredWarningBanner";
import {
  DashboardView,
  HistoryView,
  RewindView,
  AskView,
  MeetingsView,
  SavedView,
  JournalView,
  FocusView,
  SettingsView,
  ScreenshotDetail,
  ViewSuspense,
} from "@/app/routes";
import { SaveMomentDialog } from "@/features/saved/SaveMomentDialog";
import { FirstRunWizard } from "@/features/onboarding/FirstRunWizard";
import { TourOverlay } from "@/features/tour/TourOverlay";
import { RecallPalette } from "@/components/RecallPalette";
import { Button } from "@/components/ui/button";
import { Clock, Search } from "lucide-react";

const VIEW_LABELS: Record<View, string> = {
  dashboard: "Home",
  search: "Search",
  history: "History",
  rewind: "Rewind",
  ask: "Ask",
  journal: "Journal",
  saved: "Saved",
  meetings: "Meetings",
  focus: "Focus",
  settings: "Settings",
};

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

const VIEW_SHORTCUTS: { sequence: HotkeySequence; view: View }[] = [
  { sequence: ["G", "D"], view: "dashboard" },
  { sequence: ["G", "H"], view: "history" },
  { sequence: ["G", "R"], view: "rewind" },
  { sequence: ["G", "S"], view: "search" },
  { sequence: ["G", "V"], view: "saved" },
  { sequence: ["G", "J"], view: "journal" },
  { sequence: ["G", "A"], view: "ask" },
  { sequence: ["G", "M"], view: "meetings" },
  { sequence: ["G", "F"], view: "focus" },
  { sequence: ["G", ","], view: "settings" },
];

function App() {
  const [nav, dispatch] = useReducer(navReducer, initialNavState);
  const { view, subView, selectedScreenshotId, screenshotIds, rewindTimeRange } = nav;

  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string | undefined>();
  const [datePreset, setDatePreset] = useState(0);
  const [resultView, setResultView] = useState<"grid" | "list">("grid");
  const [showSaveMoment, setShowSaveMoment] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  // The detail pane only renders inside detail-capable views (see showDetail).
  // The palette is global, so route through Search first when the current view
  // can't host a detail — otherwise the click selects a frame nothing displays.
  const handleOpenFromPalette = useCallback(
    (id: number, siblingIds?: number[]) => {
      if (view === "meetings" || view === "focus" || view === "settings") {
        dispatch({ type: "CHANGE_VIEW", view: "search" });
      }
      dispatch({ type: "SELECT_RESULT", id, siblingIds });
    },
    [view],
  );

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

  // Vim-style "go to view" shortcuts: g d / g h / g r / g s / g v / g j / g a / g f / g ,
  useHotkeySequences(
    VIEW_SHORTCUTS.map(({ sequence, view: v }) => ({
      sequence,
      callback: () => handleViewChange(v),
    })),
  );

  // ⌘K / Ctrl-K — the Recall Palette, from anywhere
  useHotkey("Mod+K", (e) => {
    e.preventDefault();
    setPaletteOpen((p) => !p);
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
    <main className="flex h-screen animate-in fade-in duration-300 ease-quiet">
      <Sidebar activeView={view} onViewChange={handleViewChange} />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <GnomeExtensionBanner />
        <UnfilteredWarningBanner />
        <header className="flex items-center gap-4 px-7 h-[60px] border-b border-line shrink-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted whitespace-nowrap">
            Rewind<span className="mx-2 text-text-ghost">/</span>
            <b className="font-medium text-text-secondary">{VIEW_LABELS[view]}</b>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPaletteOpen(true)}
            className="ml-auto justify-start h-[34px] px-3 min-w-[240px] rounded-lg border border-line-2 hover:border-line-hi hover:bg-transparent text-text-muted hover:text-text-muted text-[13px] transition-colors whitespace-nowrap"
          >
            <Search className="size-[15px]" strokeWidth={1.7} />
            <span>Describe what you remember…</span>
            <span className="ml-auto font-mono text-[10.5px] border border-line-2 rounded px-1.5 py-px text-text-faint">
              ⌘K
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowSaveMoment(true)}
            className="size-[34px] grid place-items-center rounded-lg text-text-muted hover:text-text-primary hover:bg-panel transition-colors"
            title="Save moment"
          >
            <Clock className="size-[18px]" strokeWidth={1.7} />
          </Button>
          <DaemonPanel />
        </header>

        {/* keyed on view so switching views crossfades the content region */}
        <div key={view} className="flex-1 flex flex-col min-h-0 animate-in fade-in duration-200 ease-quiet">

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
          <DashboardView
            onSelectScreenshot={handleSelectResult}
            onRewindToRange={handleRewindToRange}
            onGoToSearch={() => handleViewChange("search")}
          />
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

        {view === "meetings" && subView === "list" && (
          <ViewSuspense>
            <MeetingsView onJumpToTime={(unixSecs) => handleRewindToRange(unixSecs - 120, unixSecs + 120)} />
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
      </div>

      {showSaveMoment && <SaveMomentDialog onClose={() => setShowSaveMoment(false)} />}
      <RecallPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenResult={handleOpenFromPalette}
        onRewindTo={(ts) => handleRewindToRange(ts - 120, ts + 120)}
      />
      <FirstRunWizard />
      <TourOverlay onNavigate={handleViewChange} />
    </main>
  );
}

export default App;
