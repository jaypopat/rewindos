import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { deleteScreenshotsInRange } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { HourGroupRow } from "./HourGroup";
import { RangeSelectToolbar } from "./RangeSelectToolbar";
import type { DayGroup, HourGroup } from "./history-utils";

interface TimelineModeProps {
  dayGroups: DayGroup[];
  isLoadingScreenshots: boolean;
  rangeSelectMode: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
  rangeSaveName: string;
  setRangeSaveName: (name: string) => void;
  rangeSaving: boolean;
  showRangeNameInput: boolean;
  setShowRangeNameInput: (show: boolean) => void;
  rangeDisplayText: string;
  handleRangeClick: (timestamp: number) => void;
  isEntryInRange: (timestamp: number) => boolean;
  isHourInRange: (hourKey: string) => boolean;
  handleRangeSaveAsCollection: () => void;
  clearRange: () => void;
  exitRangeSelect: () => void;
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
  start: number;
  end: number;
}

export function TimelineMode({
  dayGroups,
  isLoadingScreenshots,
  rangeSelectMode,
  rangeStart,
  rangeEnd,
  rangeSaveName,
  setRangeSaveName,
  rangeSaving,
  showRangeNameInput,
  setShowRangeNameInput,
  rangeDisplayText,
  handleRangeClick,
  isEntryInRange,
  isHourInRange,
  handleRangeSaveAsCollection,
  clearRange,
  exitRangeSelect,
  onSelectScreenshot,
  start,
  end,
}: TimelineModeProps) {
  const queryClient = useQueryClient();

  const [expandedHours, setExpandedHours] = useState<Set<string>>(new Set());
  const [showAllHours, setShowAllHours] = useState<Set<string>>(new Set());
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const toggleHour = (key: string) => {
    setExpandedHours((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleDeleteHour = useCallback(
    async (group: HourGroup) => {
      const first = group.entries[0];
      if (!first) return;

      const datePart = group.key.slice(0, 10);
      const hourNum = parseInt(group.key.slice(-2), 10);
      const hourStart = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
      const hourEnd = new Date(hourStart.getTime() + 3600_000);

      const startTs = Math.floor(hourStart.getTime() / 1000);
      const endTs = Math.floor(hourEnd.getTime() / 1000);

      setDeleting(true);
      try {
        await deleteScreenshotsInRange(startTs, endTs);
        setConfirmDeleteKey(null);
        queryClient.invalidateQueries({ queryKey: queryKeys.hourlyBrowse(start, end) });
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(start, end) });
      } catch (err) {
        console.error("Failed to delete hour:", err);
      } finally {
        setDeleting(false);
      }
    },
    [queryClient, start, end],
  );

  if (isLoadingScreenshots) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (dayGroups.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="text-center py-20 text-text-muted text-sm">
          No screenshots found in this time range.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto space-y-4 relative">
        {/* Confirm delete modal */}
        {confirmDeleteKey && (() => {
          let targetGroup: HourGroup | undefined;
          for (const dg of dayGroups) {
            targetGroup = dg.hours.find((g) => g.key === confirmDeleteKey);
            if (targetGroup) break;
          }
          if (!targetGroup) return null;
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="bg-surface-base border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
                <h3 className="text-base font-medium text-text-primary mb-2">Delete captures?</h3>
                <p className="text-sm text-text-secondary mb-4">
                  This will permanently delete <span className="font-medium text-text-primary">{targetGroup.entries.length}</span> screenshot{targetGroup.entries.length !== 1 ? "s" : ""} from{" "}
                  <span className="font-mono font-medium text-text-primary">{targetGroup.label}</span>, including their OCR data and files on disk.
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setConfirmDeleteKey(null)}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface-raised transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDeleteHour(targetGroup!)}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm rounded-lg bg-red-500/90 hover:bg-red-500 text-white font-medium transition-colors disabled:opacity-50"
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {dayGroups.map((day) => (
          <div key={day.date}>
            {/* Day header */}
            <div className="flex items-center gap-3 mb-1.5 px-1">
              <h3 className="text-sm font-medium text-text-primary">{day.label}</h3>
              <span className="text-xs text-text-muted">
                {day.totalEntries} capture{day.totalEntries !== 1 ? "s" : ""} across {day.hours.length} hour{day.hours.length !== 1 ? "s" : ""}
              </span>
              <div className="flex-1 h-px bg-border/30" />
            </div>

            {/* Hour groups for this day */}
            <div className="space-y-1">
              {day.hours.map((group) => (
                <HourGroupRow
                  key={group.key}
                  group={group}
                  isOpen={expandedHours.has(group.key)}
                  showAll={showAllHours.has(group.key)}
                  isInRange={isHourInRange(group.key)}
                  rangeSelectMode={rangeSelectMode}
                  onToggle={() => toggleHour(group.key)}
                  onShowAll={() =>
                    setShowAllHours((prev) => {
                      const next = new Set(prev);
                      next.add(group.key);
                      return next;
                    })
                  }
                  onRangeClick={handleRangeClick}
                  isEntryInRange={isEntryInRange}
                  onSelectScreenshot={onSelectScreenshot}
                  onRequestDelete={setConfirmDeleteKey}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Range selection floating toolbar */}
      {rangeSelectMode && rangeStart !== null && (
        <RangeSelectToolbar
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          rangeDisplayText={rangeDisplayText}
          rangeSaveName={rangeSaveName}
          setRangeSaveName={setRangeSaveName}
          rangeSaving={rangeSaving}
          showRangeNameInput={showRangeNameInput}
          setShowRangeNameInput={setShowRangeNameInput}
          onSaveAsCollection={handleRangeSaveAsCollection}
          onClear={clearRange}
          onExit={exitRangeSelect}
        />
      )}
    </div>
  );
}
