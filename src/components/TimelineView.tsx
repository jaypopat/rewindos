import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { browseScreenshots, getImageUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AppDot } from "./AppDot";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface TimelineViewProps {
  onSelectScreenshot: (id: number) => void;
}

const TIME_RANGES = [
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14400 },
  {
    label: "Today",
    seconds: () => {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      return Math.floor((Date.now() - now.getTime()) / 1000);
    },
  },
  { label: "24h", seconds: 86400 },
  { label: "7d", seconds: 604800 },
] as const;

export function TimelineView({ onSelectScreenshot }: TimelineViewProps) {
  const [rangeIdx, setRangeIdx] = useState(2); // Default to "Today"
  const [selectedIdx, setSelectedIdx] = useState(0);
  const filmstripRef = useRef<HTMLDivElement>(null);

  const range = TIME_RANGES[rangeIdx];
  const secondsBack =
    typeof range.seconds === "function" ? range.seconds() : range.seconds;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - secondsBack;

  const { data: results = [], isLoading } = useQuery({
    queryKey: queryKeys.timeline(startTime),
    queryFn: () => browseScreenshots(startTime, undefined, undefined, 200),
    staleTime: 15_000,
  });

  const selected = results[selectedIdx];

  // Keep selectedIdx in bounds
  useEffect(() => {
    if (selectedIdx >= results.length && results.length > 0) {
      setSelectedIdx(0);
    }
  }, [results.length, selectedIdx]);

  // Scroll filmstrip to keep selected visible
  useEffect(() => {
    if (filmstripRef.current) {
      const child = filmstripRef.current.children[selectedIdx] as HTMLElement;
      if (child) {
        child.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      }
    }
  }, [selectedIdx]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft" && selectedIdx > 0) {
        setSelectedIdx((prev) => prev - 1);
      } else if (e.key === "ArrowRight" && selectedIdx < results.length - 1) {
        setSelectedIdx((prev) => prev + 1);
      } else if (e.key === "Enter" && selected) {
        onSelectScreenshot(selected.id);
      }
    },
    [selectedIdx, results.length, selected, onSelectScreenshot],
  );

  return (
    <div
      role="listbox"
      className="flex-1 flex flex-col min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Time range selector */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-display text-base text-text-primary">
            Timeline
          </span>
          {results.length > 0 && (
            <span className="text-xs text-text-muted">
              {results.length} capture{results.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
          {TIME_RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => {
                setRangeIdx(i);
                setSelectedIdx(0);
              }}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                i === rangeIdx
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && results.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-text-muted">
            No captures in this time range
          </p>
        </div>
      )}

      {!isLoading && results.length > 0 && (
        <>
          {/* Main preview */}
          <div className="flex-1 flex items-center justify-center p-4 min-h-0">
            {selected && (
              <div className="relative max-w-full max-h-full animate-fade-in" key={selected.id}>
                <img
                  src={getImageUrl(selected.file_path)}
                  alt=""
                  className="rounded-lg border border-border/30 shadow-lg cursor-pointer hover:border-accent/30 transition-colors"
                  style={{
                    maxHeight: "calc(100vh - 280px)",
                    objectFit: "contain",
                  }}
                  onClick={() => onSelectScreenshot(selected.id)}
                />
                {/* Metadata overlay */}
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-surface/90 to-transparent p-4 pt-8 rounded-b-lg">
                  <div className="flex items-center gap-2">
                    {selected.app_name && (
                      <>
                        <AppDot appName={selected.app_name} size={6} />
                        <span className="text-xs font-medium text-text-secondary">
                          {selected.app_name}
                        </span>
                      </>
                    )}
                    <span className="text-xs text-text-muted font-mono tabular-nums ml-auto">
                      {formatTime(selected.timestamp)}
                    </span>
                  </div>
                  {selected.window_title && (
                    <p className="text-sm text-text-primary truncate mt-0.5">
                      {selected.window_title}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Filmstrip */}
          <div className="border-t border-border/30 px-5 py-3 shrink-0">
            <ScrollArea className="w-full">
              <div ref={filmstripRef} className="flex gap-1.5 pb-1 overflow-x-auto">
                {results.map((result, i) => (
                  <button
                    key={result.id}
                    onClick={() => setSelectedIdx(i)}
                    className={cn(
                      "shrink-0 w-24 h-16 rounded-md overflow-hidden border-2 transition-all",
                      i === selectedIdx
                        ? "border-accent shadow-lg shadow-accent/10"
                        : "border-transparent opacity-60 hover:opacity-100",
                    )}
                  >
                    {result.thumbnail_path ? (
                      <img
                        src={getImageUrl(result.thumbnail_path)}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-surface-overlay flex items-center justify-center">
                        <span className="text-[8px] text-text-muted font-mono">
                          {formatTime(result.timestamp)}
                        </span>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        </>
      )}
    </div>
  );
}
