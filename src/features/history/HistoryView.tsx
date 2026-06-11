import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { CalendarIcon, Crosshair } from "lucide-react";

import { useHistoryData } from "./hooks/useHistoryData";
import { useRangeSelection } from "./hooks/useRangeSelection";
import { AppsMode } from "./AppsMode";
import { TimelineMode } from "./TimelineMode";
import { RANGE_PRESETS, getRangeForDate } from "./history-utils";
import type { HistoryMode, HistoryViewProps } from "./history-utils";

export function HistoryView({ onSelectScreenshot, onRewindToRange }: HistoryViewProps) {
  const [rangeIdx, setRangeIdx] = useState<number | null>(0);
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [mode, setMode] = useState<HistoryMode>("apps");

  const { start, end } = useMemo(() => {
    if (customDate) return getRangeForDate(customDate);
    return RANGE_PRESETS[rangeIdx ?? 0].getRange();
  }, [rangeIdx, customDate]);

  const data = useHistoryData(start, end, mode);
  const range = useRangeSelection(mode, start, end);

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header + Mode toggle + Range selector */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl text-text-primary">History</h2>
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {(["apps", "timeline"] as const).map((m) => (
              <Button
                variant="ghost"
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "h-auto px-2.5 py-1 text-xs rounded-md capitalize",
                  m === mode
                    ? "bg-accent/15 text-accent font-medium hover:bg-accent/15 hover:text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-transparent",
                )}
              >
                {m === "apps" ? "Apps" : "Timeline"}
              </Button>
            ))}
          </div>
          {mode === "timeline" && (
            <Button
              variant="ghost"
              onClick={range.toggleRangeSelectMode}
              className={cn(
                "flex items-center gap-1.5 h-auto px-2.5 py-1 text-xs rounded-lg border",
                range.rangeSelectMode
                  ? "bg-accent/15 border-accent/50 text-accent font-medium hover:bg-accent/15 hover:text-accent"
                  : "border-border/50 text-text-muted hover:text-text-secondary hover:border-border hover:bg-transparent",
              )}
            >
              <Crosshair className="size-3" />
              Select Range
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {RANGE_PRESETS.map((r, i) => (
              <Button
                variant="ghost"
                key={r.label}
                onClick={() => {
                  setRangeIdx(i);
                  setCustomDate(null);
                }}
                className={cn(
                  "h-auto px-3 py-1 text-xs rounded-md",
                  i === rangeIdx && !customDate
                    ? "bg-accent/15 text-accent font-medium hover:bg-accent/15 hover:text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-transparent",
                )}
              >
                {r.label}
              </Button>
            ))}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "flex items-center gap-1.5 h-auto px-2.5 py-1 text-xs rounded-lg border bg-surface-raised cursor-pointer",
                  customDate
                    ? "border-accent/50 text-accent hover:text-accent hover:bg-surface-raised"
                    : "border-border/50 text-text-muted hover:text-text-secondary hover:bg-surface-raised",
                )}
              >
                <CalendarIcon className="size-3" />
                {customDate
                  ? new Date(customDate + "T00:00:00").toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })
                  : "Pick date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={customDate ? new Date(customDate + "T00:00:00") : undefined}
                onSelect={(date) => {
                  if (date) {
                    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
                    setCustomDate(key);
                    setRangeIdx(null);
                  }
                }}
                disabled={{ after: new Date() }}
                defaultMonth={customDate ? new Date(customDate + "T00:00:00") : undefined}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {data.isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {data.activity && data.activity.total_screenshots === 0 && (
        <div className="text-center py-20 text-text-muted text-sm">
          No captures in this time range.
        </div>
      )}

      {data.activity && data.activity.total_screenshots > 0 && mode === "apps" && (
        <AppsMode
          activity={data.activity}
          totalActiveTime={data.totalActiveTime}
          activeBlocks={data.activeBlocks}
          totalCaptures={data.totalCaptures}
          uniqueApps={data.uniqueApps}
          topAppNames={data.topAppNames}
          avgDaily={data.avgDaily}
          rangeDays={data.rangeDays}
          totalScreenTime={data.totalScreenTime}
          appGroups={data.appGroups}
          chartBlocks={data.chartBlocks}
          start={start}
          end={end}
          digestDay={data.digestDay}
          onSwitchToTimeline={() => setMode("timeline")}
        />
      )}

      {data.activity && data.activity.total_screenshots > 0 && mode === "timeline" && (
        <TimelineMode
          dayGroups={data.dayGroups}
          isLoadingScreenshots={data.isLoadingScreenshots}
          rangeSelectMode={range.rangeSelectMode}
          rangeStart={range.rangeStart}
          rangeEnd={range.rangeEnd}
          rangeSaveName={range.rangeSaveName}
          setRangeSaveName={range.setRangeSaveName}
          rangeSaving={range.rangeSaving}
          showRangeNameInput={range.showRangeNameInput}
          setShowRangeNameInput={range.setShowRangeNameInput}
          rangeDisplayText={range.rangeDisplayText}
          handleRangeClick={range.handleRangeClick}
          isEntryInRange={range.isEntryInRange}
          isHourInRange={range.isHourInRange}
          handleRangeSaveAsCollection={range.handleRangeSaveAsCollection}
          clearRange={range.clearRange}
          exitRangeSelect={range.exitRangeSelect}
          onSelectScreenshot={onSelectScreenshot}
          onRewindToRange={onRewindToRange}
          start={start}
          end={end}
        />
      )}
    </div>
  );
}
