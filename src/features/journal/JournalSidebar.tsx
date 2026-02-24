import { type JournalDateInfo, type JournalStreakInfo, type ActivityResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AppDot } from "@/components/AppDot";
import { Flame, Lightbulb, Download } from "lucide-react";
import { MiniCalendarHeatmap } from "./MiniCalendarHeatmap";
import { OpenTodosPanel } from "./OpenTodosPanel";
import { AISummaryPanel } from "./AISummaryPanel";

interface JournalSidebarProps {
  selectedDate: Date;
  calendarMonth: Date;
  journalDateMap: Map<string, JournalDateInfo>;
  onSelectDate: (d: Date) => void;
  streak: JournalStreakInfo | undefined;
  ollamaAvailable: boolean | undefined;
  activityData: ActivityResponse | undefined;
  prompts: string[];
  onInsertPrompt: (text: string) => void;
  onShowExport: () => void;
}

export function JournalSidebar({
  selectedDate,
  calendarMonth,
  journalDateMap,
  onSelectDate,
  streak,
  ollamaAvailable,
  activityData,
  prompts,
  onInsertPrompt,
  onShowExport,
}: JournalSidebarProps) {
  return (
    <div className="w-72 flex flex-col overflow-y-auto bg-surface-raised/30 shrink-0">
      <div className="px-4 py-4 space-y-5">
        {/* Mini Calendar */}
        <MiniCalendarHeatmap
          selectedDate={selectedDate}
          calendarMonth={calendarMonth}
          journalDateMap={journalDateMap}
          onSelectDate={onSelectDate}
        />

        {/* Streak */}
        {streak && (streak.current_streak > 0 || streak.total_entries > 0) && (
          <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-raised border border-border/30 rounded-lg">
            <Flame
              className={cn(
                "size-5 shrink-0",
                streak.current_streak >= 3
                  ? "text-orange-400"
                  : streak.current_streak > 0
                    ? "text-amber-400"
                    : "text-text-muted",
              )}
              strokeWidth={1.8}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">
                {streak.current_streak} day streak
              </div>
              <div className="text-[10px] text-text-muted font-mono">
                {streak.total_entries} total entries &middot; longest: {streak.longest_streak}d
              </div>
            </div>
          </div>
        )}

        {/* Open Todos */}
        <OpenTodosPanel onSelectDate={onSelectDate} />

        {/* AI Summary */}
        {ollamaAvailable && <AISummaryPanel selectedDate={selectedDate} />}

        {/* Activity breakdown */}
        {activityData && activityData.app_usage.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
              Activity
            </h3>
            <div className="space-y-1.5">
              {activityData.app_usage.slice(0, 6).map((app) => {
                const mins = Math.round((app.screenshot_count * 5) / 60);
                return (
                  <div key={app.app_name} className="flex items-center gap-2">
                    <AppDot appName={app.app_name} size={6} />
                    <span className="text-xs text-text-secondary truncate flex-1">
                      {app.app_name}
                    </span>
                    <span className="text-[10px] text-text-muted font-mono tabular-nums shrink-0">
                      {mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 text-[10px] text-text-muted font-mono">
              {activityData.total_screenshots} screenshots &middot;{" "}
              {activityData.total_apps} apps
            </div>
          </div>
        )}

        {/* Memory jogger prompts */}
        {prompts.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Lightbulb className="size-3" strokeWidth={2} />
              Prompts
            </h3>
            <div className="space-y-1.5">
              {prompts.map((p, i) => (
                <button
                  key={i}
                  onClick={() => onInsertPrompt(p)}
                  className="w-full text-left text-xs text-text-secondary hover:text-text-primary bg-surface-raised hover:bg-surface-overlay/50 border border-border/30 hover:border-accent/20 rounded-lg px-3 py-2 transition-all leading-relaxed"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Export button */}
        <button
          onClick={onShowExport}
          className="w-full flex items-center justify-center gap-1.5 text-xs text-text-muted hover:text-text-secondary bg-surface-raised hover:bg-surface-overlay/50 border border-border/30 rounded-lg px-3 py-2 transition-all"
        >
          <Download className="size-3" strokeWidth={2} />
          Export Journal
        </button>

        {/* Empty state for days with no data */}
        {activityData && activityData.total_screenshots === 0 && (
          <div className="text-center py-6">
            <p className="text-xs text-text-muted">No captured data for this day.</p>
            <p className="text-[10px] text-text-muted mt-1">
              You can still write a journal entry.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
