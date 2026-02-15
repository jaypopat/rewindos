import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  browseScreenshots,
  getActiveBlocks,
  deleteScreenshotsInRange,
  getImageUrl,
  type TimelineEntry,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { getAppColor } from "@/lib/app-colors";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  Play,
  Pause,
  Scissors,
  Trash2,
  X,
  Maximize2,
  CalendarIcon,
} from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RewindViewProps {
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

interface ActivitySegment {
  startTime: number;
  endTime: number;
  appName: string;
  color: string;
  startIdx: number;
  endIdx: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_RANGES = [
  { label: "Today", getRange: () => todayRange(0) },
  { label: "Yesterday", getRange: () => todayRange(1) },
  { label: "1h", getRange: () => lastNHours(1) },
  { label: "4h", getRange: () => lastNHours(4) },
  { label: "24h", getRange: () => lastNHours(24) },
] as const;

const SPEEDS = [1, 2, 5, 10] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayRange(daysAgo: number): { start: number; end: number } {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  const end = daysAgo === 0 ? Math.floor(Date.now() / 1000) : start + 86400;
  return { start, end };
}

function lastNHours(n: number): { start: number; end: number } {
  const now = Math.floor(Date.now() / 1000);
  return { start: now - n * 3600, end: now };
}

function formatTimeShort(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${ampm}`;
}

function formatHourLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

/** Binary search — find nearest screenshot index for a given timestamp. */
function findNearest(screenshots: TimelineEntry[], timestamp: number): number {
  if (screenshots.length === 0) return 0;
  let lo = 0;
  let hi = screenshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (screenshots[mid].timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const d1 = Math.abs(screenshots[lo].timestamp - timestamp);
    const d0 = Math.abs(screenshots[lo - 1].timestamp - timestamp);
    if (d0 < d1) return lo - 1;
  }
  return lo;
}

/** Build activity segments from consecutive screenshots. */
function buildSegments(screenshots: TimelineEntry[]): ActivitySegment[] {
  if (screenshots.length === 0) return [];
  const segments: ActivitySegment[] = [];
  let seg: ActivitySegment = {
    startTime: screenshots[0].timestamp,
    endTime: screenshots[0].timestamp,
    appName: screenshots[0].app_name ?? "Unknown",
    color: getAppColor(screenshots[0].app_name),
    startIdx: 0,
    endIdx: 0,
  };

  for (let i = 1; i < screenshots.length; i++) {
    const s = screenshots[i];
    const gap = s.timestamp - seg.endTime;
    const sameApp = (s.app_name ?? "Unknown") === seg.appName;

    if (sameApp && gap < 60) {
      seg.endTime = s.timestamp;
      seg.endIdx = i;
    } else {
      segments.push(seg);
      seg = {
        startTime: s.timestamp,
        endTime: s.timestamp,
        appName: s.app_name ?? "Unknown",
        color: getAppColor(s.app_name),
        startIdx: i,
        endIdx: i,
      };
    }
  }
  segments.push(seg);
  return segments;
}

// ---------------------------------------------------------------------------
// RewindView
// ---------------------------------------------------------------------------

export function RewindView({ onSelectScreenshot }: RewindViewProps) {
  const queryClient = useQueryClient();

  // -- Time range -----------------------------------------------------------
  const [rangeIdx, setRangeIdx] = useState(0);
  const [customDate, setCustomDate] = useState<string | null>(null); // "YYYY-MM-DD"
  const { start: startTime, end: endTime } = useMemo(() => {
    if (customDate) {
      const d = new Date(customDate + "T00:00:00");
      const start = Math.floor(d.getTime() / 1000);
      const end = start + 86400;
      return { start, end };
    }
    return TIME_RANGES[rangeIdx].getRange();
  }, [rangeIdx, customDate]);

  // -- Data -----------------------------------------------------------------
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.rewind(startTime, endTime),
    queryFn: async () => {
      const [rawScreenshots, activeBlocks] = await Promise.all([
        browseScreenshots(startTime, endTime, undefined, 100000),
        getActiveBlocks(startTime, endTime),
      ]);
      // browseScreenshots returns newest-first; we want ASC
      return {
        screenshots: rawScreenshots.reverse(),
        activeBlocks,
      };
    },
    staleTime: 30_000,
  });

  const screenshots = data?.screenshots ?? [];
  const activeBlocks = data?.activeBlocks ?? [];
  const allIds = useMemo(() => screenshots.map((s) => s.id), [screenshots]);

  // -- Playback state -------------------------------------------------------
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<(typeof SPEEDS)[number]>(1);

  // -- Range selection for bulk delete --------------------------------------
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeSelection, setRangeSelection] = useState<{
    startIdx: number;
    endIdx: number;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // -- Refs -----------------------------------------------------------------
  const isDraggingRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const hoverPreviewRef = useRef<HTMLDivElement>(null);
  const hoverImgRef = useRef<HTMLImageElement>(null);
  const hoverTimeRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hold-to-fast-forward
  const holdIntervalRef = useRef<number>(0);
  const holdDirectionRef = useRef<number>(0);
  const holdCountRef = useRef<number>(0);

  // -- Derived --------------------------------------------------------------
  const currentScreenshot = screenshots[currentIndex] ?? null;
  const segments = useMemo(() => buildSegments(screenshots), [screenshots]);

  const totalActive = useMemo(() => {
    return activeBlocks.reduce((sum, b) => sum + b.duration_secs, 0);
  }, [activeBlocks]);

  // Reset current index when data changes
  useEffect(() => {
    if (screenshots.length > 0) {
      setCurrentIndex(screenshots.length - 1);
    } else {
      setCurrentIndex(0);
    }
    setIsPlaying(false);
    setRangeSelection(null);
    setRangeMode(false);
  }, [startTime, endTime, screenshots.length]);

  // -- Auto-play ------------------------------------------------------------
  useEffect(() => {
    if (!isPlaying || screenshots.length === 0) return;
    const ms = 1000 / playbackSpeed;
    const id = window.setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= screenshots.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, ms);
    return () => clearInterval(id);
  }, [isPlaying, playbackSpeed, screenshots.length]);

  // -- Image preloading (±5 around current) ---------------------------------
  useEffect(() => {
    if (screenshots.length === 0) return;
    const lo = Math.max(0, currentIndex - 5);
    const hi = Math.min(screenshots.length - 1, currentIndex + 5);
    for (let i = lo; i <= hi; i++) {
      const img = new Image();
      img.src = getImageUrl(screenshots[i].file_path);
    }
  }, [currentIndex, screenshots]);

  // -- Position helpers for the scrubber ------------------------------------
  const pixelToTime = useCallback(
    (x: number, trackWidth: number): number => {
      const fraction = Math.max(0, Math.min(1, x / trackWidth));
      return startTime + fraction * (endTime - startTime);
    },
    [startTime, endTime],
  );

  const timeToFraction = useCallback(
    (t: number): number => {
      if (endTime === startTime) return 0;
      return Math.max(0, Math.min(1, (t - startTime) / (endTime - startTime)));
    },
    [startTime, endTime],
  );

  // -- Scrubber mouse handlers ----------------------------------------------
  const updateScrubVisuals = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || screenshots.length === 0) return;
      const rect = track.getBoundingClientRect();
      const x = clientX - rect.left;
      const ts = pixelToTime(x, rect.width);
      const idx = findNearest(screenshots, ts);
      const fraction = timeToFraction(screenshots[idx].timestamp);

      // Move handle
      if (handleRef.current) {
        handleRef.current.style.left = `${fraction * 100}%`;
      }

      // Update hover preview (used during drag)
      if (hoverImgRef.current && screenshots[idx].thumbnail_path) {
        hoverImgRef.current.src = getImageUrl(screenshots[idx].thumbnail_path!);
      }
      if (hoverTimeRef.current) {
        hoverTimeRef.current.textContent = formatTimeShort(screenshots[idx].timestamp);
      }

      return idx;
    },
    [screenshots, pixelToTime, timeToFraction],
  );

  const handleTrackMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (screenshots.length === 0) return;
      e.preventDefault();
      isDraggingRef.current = true;

      const idx = updateScrubVisuals(e.clientX);
      if (idx !== undefined) {
        if (rangeMode) {
          if (!rangeSelection) {
            setRangeSelection({ startIdx: idx, endIdx: idx });
          } else {
            setRangeSelection((prev) =>
              prev ? { ...prev, endIdx: idx } : { startIdx: idx, endIdx: idx },
            );
          }
        }
      }

      // Attach document-level listeners
      const onMove = (ev: MouseEvent) => {
        if (!isDraggingRef.current) return;
        const newIdx = updateScrubVisuals(ev.clientX);
        if (newIdx !== undefined && rangeMode && rangeSelection) {
          setRangeSelection((prev) =>
            prev ? { ...prev, endIdx: newIdx } : null,
          );
        }
      };

      const onUp = (ev: MouseEvent) => {
        isDraggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const ts = pixelToTime(x, rect.width);
        const finalIdx = findNearest(screenshots, ts);

        if (!rangeMode) {
          setCurrentIndex(finalIdx);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [screenshots, updateScrubVisuals, pixelToTime, rangeMode, rangeSelection],
  );

  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingRef.current || screenshots.length === 0) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ts = pixelToTime(x, rect.width);
      const idx = findNearest(screenshots, ts);
      const fraction = timeToFraction(screenshots[idx].timestamp);

      // Show hover preview
      if (hoverPreviewRef.current) {
        hoverPreviewRef.current.style.display = "block";
        hoverPreviewRef.current.style.left = `${fraction * 100}%`;
      }
      if (hoverImgRef.current && screenshots[idx].thumbnail_path) {
        hoverImgRef.current.src = getImageUrl(screenshots[idx].thumbnail_path!);
      }
      if (hoverTimeRef.current) {
        hoverTimeRef.current.textContent = formatTimeShort(screenshots[idx].timestamp);
      }
    },
    [screenshots, pixelToTime, timeToFraction],
  );

  const handleTrackMouseLeave = useCallback(() => {
    if (!isDraggingRef.current && hoverPreviewRef.current) {
      hoverPreviewRef.current.style.display = "none";
    }
  }, []);

  // -- Keyboard controls ----------------------------------------------------
  const startHold = useCallback(
    (direction: number) => {
      holdDirectionRef.current = direction;
      holdCountRef.current = 0;
      const tick = () => {
        holdCountRef.current++;
        const delay =
          holdCountRef.current < 5 ? 150 : holdCountRef.current < 15 ? 80 : 40;
        setCurrentIndex((prev) => {
          const next = Math.max(0, Math.min(screenshots.length - 1, prev + direction));
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: next } : { startIdx: prev, endIdx: next },
            );
          }
          return next;
        });
        holdIntervalRef.current = window.setTimeout(tick, delay);
      };
      holdIntervalRef.current = window.setTimeout(tick, 300);
    },
    [screenshots.length, rangeMode],
  );

  const stopHold = useCallback(() => {
    if (holdIntervalRef.current) {
      clearTimeout(holdIntervalRef.current);
      holdIntervalRef.current = 0;
    }
    holdDirectionRef.current = 0;
    holdCountRef.current = 0;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const moveIndex = (direction: number) => {
        setCurrentIndex((prev) => {
          const next = Math.max(0, Math.min(screenshots.length - 1, prev + direction));
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: next } : { startIdx: prev, endIdx: next },
            );
          }
          return next;
        });
      };

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (!holdDirectionRef.current) {
            moveIndex(-1);
            startHold(-1);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (!holdDirectionRef.current) {
            moveIndex(1);
            startHold(1);
          }
          break;
        case "Home":
          e.preventDefault();
          setCurrentIndex(0);
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: 0 } : { startIdx: currentIndex, endIdx: 0 },
            );
          }
          break;
        case "End":
          e.preventDefault();
          setCurrentIndex(screenshots.length - 1);
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel
                ? { ...sel, endIdx: screenshots.length - 1 }
                : { startIdx: currentIndex, endIdx: screenshots.length - 1 },
            );
          }
          break;
        case " ":
          e.preventDefault();
          if (!rangeMode) setIsPlaying((prev) => !prev);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (rangeMode && rangeSelection) {
            const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
            const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
            if (hi > lo) setShowDeleteConfirm(true);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (rangeMode && rangeSelection) {
            const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
            const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
            if (hi > lo) setShowDeleteConfirm(true);
          } else if (currentScreenshot) {
            onSelectScreenshot(currentScreenshot.id, allIds);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (rangeMode) {
            setRangeSelection(null);
            setRangeMode(false);
          }
          break;
      }
    },
    [
      screenshots.length,
      currentIndex,
      currentScreenshot,
      allIds,
      rangeMode,
      rangeSelection,
      onSelectScreenshot,
      startHold,
    ],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        stopHold();
      }
    },
    [stopHold],
  );

  // -- Range delete ---------------------------------------------------------
  const handleDeleteRange = useCallback(async () => {
    if (!rangeSelection || screenshots.length === 0) return;
    const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
    const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
    const rangeStart = screenshots[lo].timestamp;
    const rangeEnd = screenshots[hi].timestamp + 1; // +1 to include last

    await deleteScreenshotsInRange(rangeStart, rangeEnd);
    queryClient.invalidateQueries({ queryKey: ["rewind"] });
    setRangeSelection(null);
    setRangeMode(false);
    setShowDeleteConfirm(false);
  }, [rangeSelection, screenshots, queryClient]);

  // -- Compute handle position from current index ---------------------------
  const handleFraction = useMemo(() => {
    if (!currentScreenshot) return 0;
    return timeToFraction(currentScreenshot.timestamp);
  }, [currentScreenshot, timeToFraction]);

  // -- Time labels for the scrubber -----------------------------------------
  const timeLabels = useMemo(() => {
    const labels: { fraction: number; label: string }[] = [];
    const rangeSeconds = endTime - startTime;
    // Choose interval: ≤2h → 15min, ≤6h → 30min, ≤12h → 1h, else 2h
    let intervalSecs: number;
    if (rangeSeconds <= 7200) intervalSecs = 900;
    else if (rangeSeconds <= 21600) intervalSecs = 1800;
    else if (rangeSeconds <= 43200) intervalSecs = 3600;
    else intervalSecs = 7200;

    // Snap to first interval boundary
    const firstBoundary =
      Math.ceil(startTime / intervalSecs) * intervalSecs;
    for (let t = firstBoundary; t < endTime; t += intervalSecs) {
      labels.push({
        fraction: (t - startTime) / (endTime - startTime),
        label: formatHourLabel(t),
      });
    }
    return labels;
  }, [startTime, endTime]);

  // -- Compute range selection fractions ------------------------------------
  const rangeSelFractions = useMemo(() => {
    if (!rangeSelection || screenshots.length === 0) return null;
    const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
    const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
    return {
      left: timeToFraction(screenshots[lo].timestamp),
      right: timeToFraction(screenshots[hi].timestamp),
      count: hi - lo + 1,
    };
  }, [rangeSelection, screenshots, timeToFraction]);

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div
      ref={containerRef}
      className="flex-1 flex flex-col min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-display text-base text-text-primary">
            Rewind
          </span>
          {screenshots.length > 0 && (
            <span className="text-xs text-text-muted">
              {screenshots.length} captures
              {totalActive > 0 && <> &middot; {formatDuration(totalActive)} active</>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {TIME_RANGES.map((tr, i) => (
              <button
                key={tr.label}
                onClick={() => {
                  setRangeIdx(i);
                  setCustomDate(null);
                }}
                className={cn(
                  "px-3 py-1 text-xs rounded-md transition-colors",
                  i === rangeIdx && !customDate
                    ? "bg-accent/15 text-accent font-medium"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                {tr.label}
              </button>
            ))}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border bg-surface-raised transition-colors cursor-pointer",
                  customDate
                    ? "border-accent/50 text-accent"
                    : "border-border/50 text-text-muted hover:text-text-secondary",
                )}
              >
                <CalendarIcon className="size-3" />
                {customDate
                  ? new Date(customDate + "T00:00:00").toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : "Pick date"}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={customDate ? new Date(customDate + "T00:00:00") : undefined}
                onSelect={(date) => {
                  if (date) {
                    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                    setCustomDate(key);
                  }
                }}
                disabled={{ after: new Date() }}
                defaultMonth={customDate ? new Date(customDate + "T00:00:00") : undefined}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* ── Loading ───────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {/* ── Empty ─────────────────────────────────────────────────────── */}
      {!isLoading && screenshots.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <p className="text-sm text-text-secondary">No captures found</p>
            <p className="text-xs text-text-muted">
              Try a different time range or start the daemon
            </p>
          </div>
        </div>
      )}

      {/* ── Main content ──────────────────────────────────────────────── */}
      {!isLoading && screenshots.length > 0 && (
        <>
          {/* Main preview area */}
          <div className="flex-1 flex flex-col items-center justify-center min-h-0 px-5 py-3 gap-2">
            {/* Screenshot */}
            <div className="relative flex-1 w-full flex items-center justify-center min-h-0">
              {currentScreenshot && (
                <img
                  src={getImageUrl(currentScreenshot.file_path)}
                  alt=""
                  className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
                  draggable={false}
                />
              )}
              {/* Expand button */}
              {currentScreenshot && (
                <button
                  onClick={() =>
                    onSelectScreenshot(currentScreenshot.id, allIds)
                  }
                  className="absolute top-2 right-2 p-1.5 rounded-md bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
                  title="View full detail (Enter)"
                >
                  <Maximize2 className="size-4" strokeWidth={1.5} />
                </button>
              )}
            </div>

            {/* Info bar under screenshot */}
            {currentScreenshot && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-surface-raised/60 border border-border/20">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: getAppColor(currentScreenshot.app_name),
                  }}
                />
                <span className="text-sm text-text-primary truncate max-w-md">
                  {currentScreenshot.app_name ?? "Unknown"}
                  {currentScreenshot.window_title && (
                    <span className="text-text-muted">
                      {" "}
                      &middot; {currentScreenshot.window_title}
                    </span>
                  )}
                </span>
                <span className="text-xs text-text-muted font-mono tabular-nums ml-auto shrink-0">
                  {formatTimeShort(currentScreenshot.timestamp)}
                </span>
              </div>
            )}
          </div>

          {/* ── Scrubber ──────────────────────────────────────────────── */}
          <div className="shrink-0 border-t border-border/30 px-5 pt-2 pb-1">
            {/* Time labels */}
            <div className="relative h-4 mb-1">
              {timeLabels.map((tl) => (
                <span
                  key={tl.fraction}
                  className="absolute text-[10px] text-text-muted font-mono -translate-x-1/2"
                  style={{ left: `${tl.fraction * 100}%` }}
                >
                  {tl.label}
                </span>
              ))}
            </div>

            {/* Track */}
            <div
              ref={trackRef}
              className="relative h-8 rounded-md bg-surface-raised/60 cursor-pointer select-none overflow-hidden"
              onMouseDown={handleTrackMouseDown}
              onMouseMove={handleTrackMouseMove}
              onMouseLeave={handleTrackMouseLeave}
            >
              {/* Activity segments */}
              {segments.map((seg, i) => {
                const left = timeToFraction(seg.startTime) * 100;
                const right = timeToFraction(seg.endTime + 5) * 100; // +5s for last capture
                const width = Math.max(right - left, 0.3); // min visible width
                return (
                  <div
                    key={i}
                    className="absolute top-1 bottom-1 rounded-sm"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      backgroundColor: seg.color,
                      opacity: 0.7,
                    }}
                    title={`${seg.appName} (${seg.endIdx - seg.startIdx + 1} captures)`}
                  />
                );
              })}

              {/* Range selection overlay */}
              {rangeSelFractions && (
                <div
                  className="absolute top-0 bottom-0 bg-red-500/20 border-x-2 border-red-500/50 pointer-events-none"
                  style={{
                    left: `${rangeSelFractions.left * 100}%`,
                    width: `${(rangeSelFractions.right - rangeSelFractions.left) * 100}%`,
                  }}
                />
              )}

              {/* Hover preview tooltip */}
              <div
                ref={hoverPreviewRef}
                className="absolute bottom-full mb-2 -translate-x-1/2 pointer-events-none z-20 hidden"
                style={{ left: "50%" }}
              >
                <div className="bg-surface-raised border border-border/50 rounded-lg shadow-xl overflow-hidden">
                  <img
                    ref={hoverImgRef}
                    alt=""
                    className="w-40 h-24 object-cover"
                  />
                  <div className="px-2 py-1 text-center">
                    <span
                      ref={hoverTimeRef}
                      className="text-[10px] text-text-muted font-mono"
                    />
                  </div>
                </div>
              </div>

              {/* Scrub handle */}
              <div
                ref={handleRef}
                className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none z-10 transition-[left] duration-75"
                style={{ left: `${handleFraction * 100}%` }}
              >
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-background shadow" />
                <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-background shadow" />
              </div>
            </div>
          </div>

          {/* ── Controls bar ──────────────────────────────────────────── */}
          <div className="shrink-0 border-t border-border/30 px-5 py-2 flex items-center gap-3">
            {/* Play/Pause */}
            <button
              onClick={() => setIsPlaying((p) => !p)}
              className="p-1.5 rounded-md hover:bg-surface-raised transition-colors text-text-secondary hover:text-text-primary"
              title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            >
              {isPlaying ? (
                <Pause className="size-4" strokeWidth={2} />
              ) : (
                <Play className="size-4" strokeWidth={2} />
              )}
            </button>

            {/* Speed toggles */}
            <div className="flex gap-0.5 bg-surface-raised/60 rounded-md p-0.5">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setPlaybackSpeed(s)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] rounded transition-colors font-mono",
                    playbackSpeed === s
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-muted hover:text-text-secondary",
                  )}
                >
                  {s}x
                </button>
              ))}
            </div>

            {/* Separator */}
            <div className="w-px h-4 bg-border/30" />

            {/* Range select toggle */}
            <button
              onClick={() => {
                if (rangeMode) {
                  setRangeMode(false);
                  setRangeSelection(null);
                } else {
                  setRangeMode(true);
                  setRangeSelection({ startIdx: currentIndex, endIdx: currentIndex });
                }
              }}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors",
                rangeMode
                  ? "bg-red-500/15 text-red-400"
                  : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
              )}
              title="Select range for bulk delete"
            >
              <Scissors className="size-3.5" strokeWidth={1.8} />
              {rangeMode ? "Cancel" : "Select Range"}
            </button>

            {/* Range action */}
            {rangeSelFractions && rangeSelFractions.count >= 1 && (
              <>
                <span className="text-xs text-text-muted">
                  {rangeSelFractions.count} selected
                </span>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.8} />
                  Delete
                </button>
              </>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Keyboard hints */}
            <div className="hidden md:flex items-center gap-3 text-[10px] text-text-muted">
              {rangeMode ? (
                <>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      &larr; &rarr;
                    </kbd>{" "}
                    extend
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      Del
                    </kbd>{" "}
                    delete
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      Esc
                    </kbd>{" "}
                    cancel
                  </span>
                </>
              ) : (
                <>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      &larr; &rarr;
                    </kbd>{" "}
                    step
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      Space
                    </kbd>{" "}
                    play
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                      &crarr;
                    </kbd>{" "}
                    detail
                  </span>
                </>
              )}
            </div>

            {/* Counter */}
            <span className="text-xs text-text-muted font-mono tabular-nums">
              {currentIndex + 1} / {screenshots.length}
            </span>
          </div>

          {/* ── Delete confirmation dialog ─────────────────────────────── */}
          {showDeleteConfirm && rangeSelection && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
              <div className="bg-surface-raised border border-border/50 rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-text-primary">
                    Delete screenshots?
                  </h3>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="p-1 text-text-muted hover:text-text-primary"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <p className="text-sm text-text-secondary">
                  This will permanently delete{" "}
                  <span className="text-text-primary font-medium">
                    {rangeSelFractions?.count ?? 0} screenshots
                  </span>{" "}
                  between{" "}
                  {formatTimeShort(
                    screenshots[
                      Math.min(rangeSelection.startIdx, rangeSelection.endIdx)
                    ].timestamp,
                  )}{" "}
                  and{" "}
                  {formatTimeShort(
                    screenshots[
                      Math.max(rangeSelection.startIdx, rangeSelection.endIdx)
                    ].timestamp,
                  )}
                  .
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 text-xs rounded-md text-text-secondary hover:bg-surface-overlay transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteRange}
                    className="px-3 py-1.5 text-xs rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
