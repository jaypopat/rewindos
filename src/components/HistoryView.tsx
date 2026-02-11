import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getActivity,
  getTaskBreakdown,
  getActiveBlocks,
  type TaskUsageStat,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { formatDuration, formatNumber } from "@/lib/format";
import { StatCard } from "./StatCard";
import { AppDot } from "./AppDot";
import { AppDonutChart } from "./charts/AppDonutChart";
import { DailyActivityChart } from "./charts/DailyActivityChart";
import { getAppColor } from "@/lib/app-colors";
import { cn } from "@/lib/utils";
import { parseWindowTitle } from "@/lib/window-title";

interface AppTaskGroup {
  appName: string;
  totalSeconds: number;
  titles: { title: string; seconds: number }[];
}

function groupTasksByApp(tasks: TaskUsageStat[]): AppTaskGroup[] {
  const map = new Map<string, { total: number; titles: Map<string, number> }>();
  for (const t of tasks) {
    const entry = map.get(t.app_name) ?? { total: 0, titles: new Map() };
    entry.total += t.estimated_seconds;
    if (t.window_title) {
      const parsed = parseWindowTitle(t.window_title, t.app_name);
      entry.titles.set(
        parsed,
        (entry.titles.get(parsed) ?? 0) + t.estimated_seconds,
      );
    }
    map.set(t.app_name, entry);
  }
  return [...map.entries()]
    .map(([appName, { total, titles }]) => ({
      appName,
      totalSeconds: total,
      titles: [...titles.entries()]
        .map(([title, seconds]) => ({ title, seconds }))
        .sort((a, b) => b.seconds - a.seconds)
        .slice(0, 3),
    }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
}

function formatSecs(secs: number): string {
  const mins = Math.round(secs / 60);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

const RANGE_PRESETS = [
  {
    label: "Yesterday",
    getRange: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const todayStart = Math.floor(d.getTime() / 1000);
      return { start: todayStart - 86400, end: todayStart };
    },
  },
  {
    label: "This Week",
    getRange: () => {
      const d = new Date();
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday start
      d.setHours(0, 0, 0, 0);
      const todayEnd = Math.floor(d.getTime() / 1000) + 86400;
      d.setDate(d.getDate() - diff);
      const weekStart = Math.floor(d.getTime() / 1000);
      return { start: weekStart, end: todayEnd };
    },
  },
  {
    label: "Last Week",
    getRange: () => {
      const d = new Date();
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1;
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - diff);
      const thisWeekStart = Math.floor(d.getTime() / 1000);
      return { start: thisWeekStart - 7 * 86400, end: thisWeekStart };
    },
  },
  {
    label: "This Month",
    getRange: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const todayEnd = Math.floor(d.getTime() / 1000) + 86400;
      d.setDate(1);
      const monthStart = Math.floor(d.getTime() / 1000);
      return { start: monthStart, end: todayEnd };
    },
  },
] as const;

export function HistoryView() {
  const [rangeIdx, setRangeIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { start, end } = useMemo(
    () => RANGE_PRESETS[rangeIdx].getRange(),
    [rangeIdx],
  );

  const rangeDays = Math.max(1, Math.round((end - start) / 86400));

  // Activity data (for charts)
  const { data: activity, isLoading } = useQuery({
    queryKey: queryKeys.activity(start),
    queryFn: () => getActivity(start),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Task breakdown
  const { data: taskStats = [] } = useQuery({
    queryKey: ["taskBreakdown", start, end],
    queryFn: () => getTaskBreakdown(start, end, 200),
    staleTime: 60_000,
  });

  // Active blocks
  const { data: activeBlocks = [] } = useQuery({
    queryKey: ["activeBlocks", start, end],
    queryFn: () => getActiveBlocks(start, end),
    staleTime: 60_000,
  });

  const totalScreenTime = useMemo(
    () => taskStats.reduce((sum, t) => sum + t.estimated_seconds, 0),
    [taskStats],
  );

  const totalActiveTime = useMemo(
    () => activeBlocks.reduce((sum, b) => sum + b.duration_secs, 0),
    [activeBlocks],
  );

  const appGroups = useMemo(() => groupTasksByApp(taskStats), [taskStats]);

  const totalCaptures = useMemo(
    () => taskStats.reduce((sum, t) => sum + t.screenshot_count, 0),
    [taskStats],
  );

  const uniqueApps = useMemo(
    () => new Set(taskStats.map((t) => t.app_name)).size,
    [taskStats],
  );

  const topAppNames = useMemo(
    () => appGroups.slice(0, 3).map((g) => g.appName).join(", "),
    [appGroups],
  );

  const avgDaily = rangeDays > 0 ? Math.round(totalActiveTime / rangeDays) : 0;

  const toggle = (app: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header + Range selector */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-xl text-text-primary">History</h2>
        <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
          {RANGE_PRESETS.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
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
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {activity && activity.total_screenshots === 0 && (
        <div className="text-center py-20 text-text-muted text-sm">
          No captures in this time range.
        </div>
      )}

      {activity && activity.total_screenshots > 0 && (
        <div className="flex-1 flex flex-col min-h-0 space-y-4">
          {/* Stats */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <StatCard
              label="Screen Time"
              value={formatDuration(totalActiveTime)}
              detail={`${activeBlocks.length} active blocks`}
              accentColor="#22d3ee"
            />
            <StatCard
              label="Captures"
              value={formatNumber(totalCaptures)}
              detail="screenshots"
              accentColor="#a78bfa"
            />
            <StatCard
              label="Active Apps"
              value={uniqueApps}
              detail={topAppNames}
              accentColor="#34d399"
            />
            <StatCard
              label="Avg Daily"
              value={formatDuration(avgDaily)}
              detail={`over ${rangeDays} day${rangeDays > 1 ? "s" : ""}`}
              accentColor="#fb923c"
            />
          </div>

          {/* Charts row — compact */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="Captures by Day" compact>
              <DailyActivityChart data={activity.daily_activity} />
            </ChartCard>
            <ChartCard title="App Distribution" compact>
              <AppDonutChart data={activity.app_usage} />
            </ChartCard>
          </div>

          {/* Task Breakdown (fills remaining space) */}
          {appGroups.length > 0 && (
            <section className="flex-1 flex flex-col min-h-0">
              <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
                Task Breakdown
              </h2>
              <div className="border border-border/50 divide-y divide-border/30 flex-1 overflow-y-auto">
                {appGroups.map((group) => {
                  const isOpen = expanded.has(group.appName);
                  const pct = totalScreenTime > 0 ? (group.totalSeconds / totalScreenTime) * 100 : 0;
                  return (
                    <div key={group.appName}>
                      <button
                        onClick={() => toggle(group.appName)}
                        className="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-raised/40 transition-colors text-left"
                      >
                        <AppDot appName={group.appName} size={8} />
                        <span className="text-sm text-text-primary flex-1 truncate">
                          {group.appName}
                        </span>
                        <span className="text-xs text-text-muted font-mono tabular-nums shrink-0">
                          {formatSecs(group.totalSeconds)}
                        </span>
                        <div className="w-20 h-1.5 bg-surface-raised rounded-full shrink-0 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: getAppColor(group.appName),
                              opacity: 0.8,
                            }}
                          />
                        </div>
                        {group.titles.length > 0 && (
                          <svg
                            className={`size-3.5 text-text-muted transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={2}
                            stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                          </svg>
                        )}
                      </button>
                      {isOpen && group.titles.length > 0 && (
                        <div className="bg-surface-raised/20 px-4 pb-2">
                          {group.titles.map((t) => (
                            <div
                              key={t.title}
                              className="flex items-center gap-3 py-1.5 pl-5"
                            >
                              <span className="w-1 h-1 rounded-full bg-text-muted/40 shrink-0" />
                              <span className="text-xs text-text-secondary flex-1 truncate">
                                {t.title}
                              </span>
                              <span className="text-[11px] text-text-muted font-mono tabular-nums shrink-0">
                                {formatSecs(t.seconds)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ChartCard({
  title,
  children,
  compact,
}: {
  title: string;
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn(
      "bg-surface-raised rounded-xl border border-border/50",
      compact ? "p-3" : "p-4",
    )}>
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
        {title}
      </h3>
      <div className={compact ? "max-h-[180px] overflow-hidden" : ""}>
        {children}
      </div>
    </div>
  );
}
