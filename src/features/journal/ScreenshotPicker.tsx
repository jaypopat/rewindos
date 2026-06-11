import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { browseScreenshots, search, getImageUrl, type TimelineEntry, type AppUsageStat } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { X, ImageIcon, Search, Grid3X3, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 50;

interface ScreenshotPickerProps {
  dayStart: number;
  dayEnd: number;
  attachedIds: number[];
  appUsage?: AppUsageStat[];
  onAttach: (id: number) => void;
  onClose: () => void;
}

export function ScreenshotPicker({
  dayStart,
  dayEnd,
  attachedIds,
  appUsage,
  onAttach,
  onClose,
}: ScreenshotPickerProps) {
  const [mode, setMode] = useState<"browse" | "search">("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string | undefined>(undefined);
  const [browseOffset, setBrowseOffset] = useState(0);
  const [searchOffset, setSearchOffset] = useState(0);
  const [accumulated, setAccumulated] = useState<TimelineEntry[]>([]);

  // Browse mode query — pure fetcher; accumulation happens in the effect
  // below. Side effects in queryFn double rows on any refetch.
  const { data: browseData, isLoading: browseLoading, isFetching: browseFetching } = useQuery({
    queryKey: [...queryKeys.journalPicker(dayStart, dayEnd), appFilter, browseOffset],
    queryFn: () => browseScreenshots(dayStart, dayEnd, appFilter, PAGE_SIZE, browseOffset),
    enabled: mode === "browse",
  });

  useEffect(() => {
    if (!browseData) return;
    if (browseOffset === 0) {
      setAccumulated(browseData);
    } else {
      setAccumulated((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...browseData.filter((e) => !seen.has(e.id))];
      });
    }
  }, [browseData, browseOffset]);

  // Search mode query
  const [searchResults, setSearchResults] = useState<TimelineEntry[]>([]);
  const { data: searchData, isLoading: searchLoading, isFetching: searchFetching } = useQuery({
    queryKey: ["screenshot-picker-search", searchQuery, searchOffset],
    queryFn: async () => {
      const resp = await search(searchQuery, {
        limit: PAGE_SIZE,
        offset: searchOffset,
      });
      return resp.results.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        app_name: r.app_name,
        window_title: r.window_title,
        thumbnail_path: r.thumbnail_path,
        file_path: r.file_path,
      })) satisfies TimelineEntry[];
    },
    enabled: mode === "search" && searchQuery.trim().length > 0,
  });

  useEffect(() => {
    if (!searchData) return;
    if (searchOffset === 0) {
      setSearchResults(searchData);
    } else {
      setSearchResults((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...searchData.filter((e) => !seen.has(e.id))];
      });
    }
  }, [searchData, searchOffset]);

  const displayItems = mode === "browse" ? accumulated : searchResults;
  const isLoading = mode === "browse" ? browseLoading : searchLoading;
  const isFetching = mode === "browse" ? browseFetching : searchFetching;
  const lastBatchFull = (mode === "browse" ? (browseData ?? []) : searchResults).length >= PAGE_SIZE;

  const attachedSet = new Set(attachedIds);

  const handleLoadMore = useCallback(() => {
    if (mode === "browse") {
      setBrowseOffset((prev) => prev + PAGE_SIZE);
    } else {
      setSearchOffset((prev) => prev + PAGE_SIZE);
    }
  }, [mode]);

  const handleAppFilter = useCallback((app: string | undefined) => {
    setAppFilter(app);
    setBrowseOffset(0);
    setAccumulated([]);
  }, []);

  const handleSearchSubmit = useCallback(() => {
    if (!searchQuery.trim()) return;
    setSearchOffset(0);
    setSearchResults([]);
  }, [searchQuery]);

  return (
    <div className="mt-2 p-3 bg-surface-raised border border-border/50 rounded-lg">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {/* Mode toggle */}
          <Button variant="quiet" type="button"
            onClick={() => { setMode("browse"); setSearchQuery(""); setSearchResults([]); setSearchOffset(0); }}
            className={cn(
              "h-auto flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded transition-colors",
              mode === "browse" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text-secondary",
            )}
          >
            <Grid3X3 className="size-3" strokeWidth={2} />
            browse
          </Button>
          <Button variant="quiet" type="button"
            onClick={() => setMode("search")}
            className={cn(
              "h-auto flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded transition-colors",
              mode === "search" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text-secondary",
            )}
          >
            <Search className="size-3" strokeWidth={2} />
            search
          </Button>
        </div>
        <Button variant="quiet" size="icon-xs" type="button" onClick={onClose} className="size-auto text-text-muted hover:text-text-secondary transition-colors">
          <X className="size-3.5" strokeWidth={2} />
        </Button>
      </div>

      {/* Search input (search mode) */}
      {mode === "search" && (
        <div className="flex items-center gap-2 mb-2">
          <div className="flex-1 flex items-center gap-1.5 px-2 py-1.5 border border-border/50 bg-surface-overlay/50 rounded">
            <Search className="size-3 text-text-muted shrink-0" strokeWidth={2} />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearchSubmit(); }}
              placeholder="Search all screenshots..."
              className="h-auto flex-1 rounded-none border-0 bg-transparent p-0 text-xs placeholder:text-text-muted/50"
              ref={(el) => el?.focus()}
            />
          </div>
          <Button variant="ghost" type="button"
            onClick={handleSearchSubmit}
            disabled={!searchQuery.trim()}
            className={cn(
              "h-auto px-2 py-1.5 text-[11px] font-mono rounded transition-colors",
              searchQuery.trim() ? "text-accent hover:bg-accent/10" : "text-text-muted/30",
            )}
          >
            go
          </Button>
        </div>
      )}

      {/* App filter chips (browse mode) */}
      {mode === "browse" && appUsage && appUsage.length > 0 && (
        <div className="flex gap-1 flex-wrap mb-2">
          <Button variant="quiet" type="button"
            onClick={() => handleAppFilter(undefined)}
            className={cn(
              "h-auto px-2 py-0.5 text-[10px] font-mono rounded-full border transition-colors",
              !appFilter
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-border/40 text-text-muted hover:text-text-secondary",
            )}
          >
            all
          </Button>
          {appUsage.slice(0, 8).map((app) => (
            <Button variant="quiet" type="button"
              key={app.app_name}
              onClick={() => handleAppFilter(appFilter === app.app_name ? undefined : app.app_name)}
              className={cn(
                "h-auto px-2 py-0.5 text-[10px] font-mono rounded-full border transition-colors truncate max-w-[120px]",
                appFilter === app.app_name
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border/40 text-text-muted hover:text-text-secondary",
              )}
            >
              {app.app_name.toLowerCase()}
            </Button>
          ))}
        </div>
      )}

      {/* Grid */}
      {isLoading && displayItems.length === 0 ? (
        <div className="flex items-center justify-center py-4">
          <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : displayItems.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-4">
          {mode === "search" && !searchQuery.trim()
            ? "Type a query and press Enter to search."
            : "No screenshots found."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-1.5 max-h-60 overflow-y-auto">
            {displayItems.map((ss) => {
              const isAttached = attachedSet.has(ss.id);
              return (
                <button type="button"
                  key={ss.id}
                  onClick={() => !isAttached && onAttach(ss.id)}
                  disabled={isAttached}
                  className={cn(
                    "aspect-video rounded overflow-hidden border transition-all",
                    isAttached
                      ? "border-accent/50 opacity-50 cursor-not-allowed"
                      : "border-border/30 hover:border-accent/30 cursor-pointer",
                  )}
                >
                  {ss.thumbnail_path ? (
                    <img
                      src={getImageUrl(ss.thumbnail_path)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : ss.file_path ? (
                    <img
                      src={getImageUrl(ss.file_path)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full bg-surface-overlay flex items-center justify-center text-text-muted">
                      <ImageIcon className="size-4 opacity-30" strokeWidth={1} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Load more */}
          {lastBatchFull && (
            <Button variant="quiet" type="button"
              onClick={handleLoadMore}
              disabled={isFetching}
              className="mt-2 h-auto w-full flex items-center justify-center gap-1 py-1.5 text-[11px] font-mono text-text-muted hover:text-text-secondary border border-border/30 rounded transition-colors disabled:opacity-50"
            >
              {isFetching ? (
                <div className="w-3 h-3 border border-accent/30 border-t-accent rounded-full animate-spin" />
              ) : (
                <>
                  <ChevronDown className="size-3" strokeWidth={2} />
                  load more
                </>
              )}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
