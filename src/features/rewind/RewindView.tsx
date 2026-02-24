import { useState, useMemo, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteScreenshotsInRange } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";

import {
  TIME_RANGES,
  formatTimeShort,
  type RewindViewProps,
} from "@/features/rewind/rewind-utils";
import { useRewindData } from "@/features/rewind/hooks/useRewindData";
import { usePlayback } from "@/features/rewind/hooks/usePlayback";
import { useScrubber } from "@/features/rewind/hooks/useScrubber";
import { useRewindKeyboard } from "@/features/rewind/hooks/useRewindKeyboard";
import { RewindPlayer } from "@/features/rewind/RewindPlayer";
import { RewindScrubber } from "@/features/rewind/RewindScrubber";
import { RewindControls } from "@/features/rewind/RewindControls";

export function RewindView({ onSelectScreenshot }: RewindViewProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);

  // -- Time range -----------------------------------------------------------
  const [rangeIdx, setRangeIdx] = useState(0);
  const [customDate, setCustomDate] = useState<string | null>(null);
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
  const { screenshots, segments, totalActive, allIds, isLoading } =
    useRewindData(startTime, endTime);

  // -- Playback -------------------------------------------------------------
  const {
    currentIndex,
    setCurrentIndex,
    isPlaying,
    setIsPlaying,
    playbackSpeed,
    setPlaybackSpeed,
  } = usePlayback(screenshots);

  // -- Range selection for bulk delete --------------------------------------
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeSelection, setRangeSelection] = useState<{
    startIdx: number;
    endIdx: number;
  } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // -- Reset current index when data changes --------------------------------
  const dataResetKey = `${startTime}-${endTime}-${screenshots.length}`;
  const prevDataResetKeyRef = useRef(dataResetKey);
  if (prevDataResetKeyRef.current !== dataResetKey) {
    prevDataResetKeyRef.current = dataResetKey;
    setCurrentIndex(screenshots.length > 0 ? screenshots.length - 1 : 0);
    setIsPlaying(false);
    setRangeSelection(null);
    setRangeMode(false);
  }

  const currentScreenshot = screenshots[currentIndex] ?? null;

  // -- Scrubber -------------------------------------------------------------
  const {
    trackRef,
    handleRef,
    hoverPreviewRef,
    hoverImgRef,
    hoverTimeRef,
    handleTrackMouseDown,
    handleTrackMouseMove,
    handleTrackMouseLeave,
    handleFraction,
    timeLabels,
    rangeSelFractions,
    timeToFraction,
  } = useScrubber(
    screenshots,
    startTime,
    endTime,
    currentIndex,
    setCurrentIndex,
    rangeMode,
    rangeSelection,
    setRangeSelection,
  );

  // -- Keyboard -------------------------------------------------------------
  const { handleKeyDown, handleKeyUp } = useRewindKeyboard({
    screenshots,
    currentIndex,
    setCurrentIndex,
    isPlaying,
    setIsPlaying,
    rangeMode,
    setRangeMode,
    rangeSelection,
    setRangeSelection,
    setShowDeleteConfirm,
    currentScreenshot,
    allIds,
    onSelectScreenshot,
  });

  // -- Range delete ---------------------------------------------------------
  const handleDeleteRange = useCallback(async () => {
    if (!rangeSelection || screenshots.length === 0) return;
    const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
    const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
    const rangeStart = screenshots[lo].timestamp;
    const rangeEnd = screenshots[hi].timestamp + 1;

    await deleteScreenshotsInRange(rangeStart, rangeEnd);
    queryClient.invalidateQueries({ queryKey: ["rewind"] });
    setRangeSelection(null);
    setRangeMode(false);
    setShowDeleteConfirm(false);
  }, [rangeSelection, screenshots, queryClient]);

  const handleToggleRangeMode = useCallback(() => {
    if (rangeMode) {
      setRangeMode(false);
      setRangeSelection(null);
    } else {
      setRangeMode(true);
      setRangeSelection({ startIdx: currentIndex, endIdx: currentIndex });
    }
  }, [rangeMode, currentIndex]);

  // =========================================================================
  // Render
  // =========================================================================

  return (
    <div
      ref={containerRef}
      role="application"
      className="flex-1 flex flex-col min-h-0 outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-display text-base text-text-primary">Rewind</span>
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

      {/* Loading */}
      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {/* Empty */}
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

      {/* Main content */}
      {!isLoading && screenshots.length > 0 && (
        <>
          <RewindPlayer
            currentScreenshot={currentScreenshot}
            allIds={allIds}
            onSelectScreenshot={onSelectScreenshot}
          />

          <RewindScrubber
            segments={segments}
            timeLabels={timeLabels}
            handleFraction={handleFraction}
            rangeSelFractions={rangeSelFractions}
            timeToFraction={timeToFraction}
            trackRef={trackRef}
            handleRef={handleRef}
            hoverPreviewRef={hoverPreviewRef}
            hoverImgRef={hoverImgRef}
            hoverTimeRef={hoverTimeRef}
            onTrackMouseDown={handleTrackMouseDown}
            onTrackMouseMove={handleTrackMouseMove}
            onTrackMouseLeave={handleTrackMouseLeave}
          />

          <RewindControls
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            playbackSpeed={playbackSpeed}
            setPlaybackSpeed={setPlaybackSpeed}
            rangeMode={rangeMode}
            currentIndex={currentIndex}
            onToggleRangeMode={handleToggleRangeMode}
            rangeSelFractions={rangeSelFractions}
            onDeleteClick={() => setShowDeleteConfirm(true)}
            screenshotCount={screenshots.length}
          />

          {/* Delete confirmation dialog */}
          {showDeleteConfirm && rangeSelection && (
            <ConfirmDialog
              title="Delete screenshots?"
              description={
                <>
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
                </>
              }
              confirmLabel="Delete"
              destructive
              onConfirm={handleDeleteRange}
              onCancel={() => setShowDeleteConfirm(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
