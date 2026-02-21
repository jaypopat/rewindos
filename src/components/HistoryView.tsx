import { useState, useMemo, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getActivity,
  getTaskBreakdown,
  getActiveBlocks,
  browseScreenshots,
  deleteScreenshotsInRange,
  createCollection,
  getImageUrl,
  type TaskUsageStat,
  type TimelineEntry,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { formatDuration, formatNumber } from "@/lib/format";
import { StatCard } from "./StatCard";
import { AppDot } from "./AppDot";
import { AppDonutChart } from "./charts/AppDonutChart";
import { ScreenTimeChart } from "./charts/ScreenTimeChart";
import { getAppColor } from "@/lib/app-colors";
import { cn } from "@/lib/utils";
import { parseWindowTitle } from "@/lib/window-title";
import { DailyDigestCard } from "./DailyDigestCard";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, ChevronDown, ChevronRight, Crosshair, FolderPlus, Trash2, X } from "lucide-react";

type HistoryMode = "apps" | "timeline";

interface HistoryViewProps {
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

interface AppTaskGroup {
  appName: string;
  totalSeconds: number;
  titles: { title: string; seconds: number }[];
}

interface HourGroup {
  /** Hour key like "2026-02-13T14" for sorting/uniqueness */
  key: string;
  /** Display label like "14:00 — 15:00" */
  label: string;
  /** All entries in this hour, sorted by timestamp */
  entries: TimelineEntry[];
  /** Top app names for the summary */
  topApps: string[];
}

interface DayGroup {
  /** Date string like "2026-02-13" */
  date: string;
  /** Display label like "Thursday, Feb 13" */
  label: string;
  /** Hour groups within this day */
  hours: HourGroup[];
  /** Total screenshots this day */
  totalEntries: number;
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

function groupByDay(entries: TimelineEntry[]): DayGroup[] {
  // First group by hour key
  const hourMap = new Map<string, TimelineEntry[]>();

  for (const entry of entries) {
    const d = new Date(entry.timestamp * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const hour = d.getHours();
    const key = `${dateStr}T${String(hour).padStart(2, "0")}`;
    const group = hourMap.get(key) ?? [];
    group.push(entry);
    hourMap.set(key, group);
  }

  const hourGroups: HourGroup[] = [...hourMap.entries()]
    .map(([key, items]) => {
      items.sort((a, b) => a.timestamp - b.timestamp);
      const hour = parseInt(key.slice(-2), 10);
      const nextHour = (hour + 1) % 24;
      const label = `${String(hour).padStart(2, "0")}:00 — ${String(nextHour).padStart(2, "0")}:00`;

      const appCounts = new Map<string, number>();
      for (const e of items) {
        if (e.app_name) {
          appCounts.set(e.app_name, (appCounts.get(e.app_name) ?? 0) + 1);
        }
      }
      const topApps = [...appCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => name);

      return { key, label, entries: items, topApps };
    })
    .sort((a, b) => b.key.localeCompare(a.key));

  // Group hours by day
  const dayMap = new Map<string, HourGroup[]>();
  for (const hg of hourGroups) {
    const date = hg.key.slice(0, 10);
    const existing = dayMap.get(date) ?? [];
    existing.push(hg);
    dayMap.set(date, existing);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const yesterdayDate = new Date(today.getTime() - 86400_000);
  const yesterdayStr = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, "0")}-${String(yesterdayDate.getDate()).padStart(2, "0")}`;

  return [...dayMap.entries()]
    .map(([date, hours]) => {
      const d = new Date(date + "T00:00:00");
      let label: string;
      if (date === todayStr) {
        label = "Today";
      } else if (date === yesterdayStr) {
        label = "Yesterday";
      } else {
        label = d.toLocaleDateString(undefined, {
          weekday: "long",
          month: "short",
          day: "numeric",
        });
      }
      const totalEntries = hours.reduce((sum, h) => sum + h.entries.length, 0);
      return { date, label, hours, totalEntries };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Sample N evenly-spaced items from an array */
function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
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
    label: "Today",
    getRange: () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const todayStart = Math.floor(d.getTime() / 1000);
      return { start: todayStart, end: todayStart + 86400 };
    },
  },
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

function getRangeForDate(dateStr: string): { start: number; end: number } {
  const d = new Date(dateStr + "T00:00:00");
  const start = Math.floor(d.getTime() / 1000);
  return { start, end: start + 86400 };
}

function hourKeyToTimestamp(key: string): number {
  const datePart = key.slice(0, 10);
  const hourNum = parseInt(key.slice(-2), 10);
  const d = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
  return Math.floor(d.getTime() / 1000);
}

export function HistoryView({ onSelectScreenshot }: HistoryViewProps) {
  const [rangeIdx, setRangeIdx] = useState<number | null>(0);
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [mode, setMode] = useState<HistoryMode>("apps");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedHours, setExpandedHours] = useState<Set<string>>(new Set());
  const [showAllHours, setShowAllHours] = useState<Set<string>>(new Set());

  // Range selection state
  const [rangeSelectMode, setRangeSelectMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const [rangeSaveName, setRangeSaveName] = useState("");
  const [rangeSaving, setRangeSaving] = useState(false);
  const [showRangeNameInput, setShowRangeNameInput] = useState(false);

  const { start, end } = useMemo(() => {
    if (customDate) return getRangeForDate(customDate);
    return RANGE_PRESETS[rangeIdx ?? 0].getRange();
  }, [rangeIdx, customDate]);

  const rangeDays = Math.max(1, Math.round((end - start) / 86400));

  // Activity data (for charts)
  const { data: activity, isLoading } = useQuery({
    queryKey: queryKeys.activity(start, end),
    queryFn: () => getActivity(start, end),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Task breakdown
  const { data: taskStats = [] } = useQuery({
    queryKey: ["taskBreakdown", start, end],
    queryFn: () => getTaskBreakdown(start, end, 200),
    staleTime: 60_000,
  });

  // Active blocks (selected range — for stats)
  const { data: activeBlocks = [] } = useQuery({
    queryKey: ["activeBlocks", start, end],
    queryFn: () => getActiveBlocks(start, end),
    staleTime: 60_000,
  });

  // Active blocks (last 14 days — for chart context)
  const chartStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - 13 * 86400;
  }, []);
  const chartEnd = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) + 86400;
  }, []);
  const { data: chartBlocks = [] } = useQuery({
    queryKey: ["activeBlocks-chart", chartStart, chartEnd],
    queryFn: () => getActiveBlocks(chartStart, chartEnd),
    staleTime: 120_000,
  });

  // Browse screenshots (for timeline mode)
  const { data: screenshots = [], isLoading: isLoadingScreenshots } = useQuery({
    queryKey: queryKeys.hourlyBrowse(start, end),
    queryFn: () => browseScreenshots(start, end, undefined, 100000),
    staleTime: 60_000,
    enabled: mode === "timeline",
  });

  const dayGroups = useMemo(
    () => (mode === "timeline" ? groupByDay(screenshots) : []),
    [screenshots, mode],
  );

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

  const uniqueApps = new Set(taskStats.map((t) => t.app_name)).size;

  const topAppNames = useMemo(
    () => appGroups.slice(0, 3).map((g) => g.appName).join(", "),
    [appGroups],
  );

  const avgDaily = rangeDays > 0 ? Math.round(totalActiveTime / rangeDays) : 0;

  // Compute digest for single-day views only
  const digestDay = useMemo(() => {
    if (rangeDays !== 1) return null;
    const d = new Date(start * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayStr = (() => {
      const t = new Date();
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    })();
    return { dateKey: key, start, end, isToday: key === todayStr };
  }, [start, end, rangeDays]);

  const toggle = (app: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  };

  const toggleHour = (key: string) => {
    setExpandedHours((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Delete hour group
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saveCollectionKey, setSaveCollectionKey] = useState<string | null>(null);
  const [saveCollectionName, setSaveCollectionName] = useState("");
  const [savingCollection, setSavingCollection] = useState(false);
  const queryClient = useQueryClient();

  const handleDeleteHour = useCallback(
    async (group: HourGroup) => {
      const first = group.entries[0];
      if (!first) return;

      // Compute the hour start/end from the key (e.g. "2026-02-13T14")
      const datePart = group.key.slice(0, 10); // "2026-02-13"
      const hourNum = parseInt(group.key.slice(-2), 10);
      const hourStart = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
      const hourEnd = new Date(hourStart.getTime() + 3600_000);

      const startTs = Math.floor(hourStart.getTime() / 1000);
      const endTs = Math.floor(hourEnd.getTime() / 1000);

      setDeleting(true);
      try {
        await deleteScreenshotsInRange(startTs, endTs);
        setConfirmDeleteKey(null);
        // Invalidate queries so the UI refreshes
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

  const handleSaveAsCollection = useCallback(
    async (group: HourGroup) => {
      if (!saveCollectionName.trim()) return;
      const datePart = group.key.slice(0, 10);
      const hourNum = parseInt(group.key.slice(-2), 10);
      const hourStart = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
      const hourEnd = new Date(hourStart.getTime() + 3600_000);
      const startTs = Math.floor(hourStart.getTime() / 1000);
      const endTs = Math.floor(hourEnd.getTime() / 1000);

      setSavingCollection(true);
      try {
        await createCollection({
          name: saveCollectionName.trim(),
          start_time: startTs,
          end_time: endTs,
        });
        setSaveCollectionKey(null);
        setSaveCollectionName("");
        queryClient.invalidateQueries({ queryKey: ["collections"] });
      } catch (err) {
        console.error("Failed to save collection:", err);
      } finally {
        setSavingCollection(false);
      }
    },
    [saveCollectionName, queryClient],
  );

  // --- Range selection ---

  // Clear range selection when switching modes or changing date range
  const rangeResetKey = `${mode}-${start}-${end}`;
  const prevRangeResetKeyRef = useRef(rangeResetKey);
  if (prevRangeResetKeyRef.current !== rangeResetKey) {
    prevRangeResetKeyRef.current = rangeResetKey;
    setRangeSelectMode(false);
    setRangeStart(null);
    setRangeEnd(null);
    setShowRangeNameInput(false);
    setRangeSaveName("");
  }

  const handleRangeClick = useCallback(
    (timestamp: number) => {
      if (rangeStart === null || rangeEnd !== null) {
        // First click or third click (reset)
        setRangeStart(timestamp);
        setRangeEnd(null);
        setShowRangeNameInput(false);
      } else {
        // Second click — set end, auto-sort
        const lo = Math.min(rangeStart, timestamp);
        const hi = Math.max(rangeStart, timestamp);
        setRangeStart(lo);
        setRangeEnd(hi);
      }
    },
    [rangeStart, rangeEnd],
  );

  const isEntryInRange = (timestamp: number): boolean => {
    if (!rangeSelectMode || rangeStart === null) return false;
    if (rangeEnd === null) return timestamp === rangeStart;
    return timestamp >= rangeStart && timestamp <= rangeEnd;
  };

  const isHourInRange = (hourKey: string): boolean => {
    if (!rangeSelectMode || rangeStart === null) return false;
    const hs = hourKeyToTimestamp(hourKey);
    const he = hs + 3600;
    if (rangeEnd === null) {
      return rangeStart >= hs && rangeStart < he;
    }
    return hs <= rangeEnd && he > rangeStart;
  };

  const rangeDisplayText = useMemo(() => {
    if (rangeStart === null) return "";
    if (rangeEnd === null) return "Click to set end point";
    const startDate = new Date(rangeStart * 1000);
    const endDate = new Date(rangeEnd * 1000);
    const timeFmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateFmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const sameDay = startDate.toDateString() === endDate.toDateString();
    if (sameDay) {
      return `${timeFmt(startDate)} — ${timeFmt(endDate)} (${dateFmt(startDate)})`;
    }
    return `${dateFmt(startDate)} ${timeFmt(startDate)} — ${dateFmt(endDate)} ${timeFmt(endDate)}`;
  }, [rangeStart, rangeEnd]);

  const handleRangeSaveAsCollection = useCallback(async () => {
    if (!rangeSaveName.trim() || rangeStart === null || rangeEnd === null) return;
    setRangeSaving(true);
    try {
      await createCollection({
        name: rangeSaveName.trim(),
        start_time: rangeStart,
        end_time: rangeEnd,
      });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setRangeSelectMode(false);
      setRangeStart(null);
      setRangeEnd(null);
      setShowRangeNameInput(false);
      setRangeSaveName("");
    } catch (err) {
      console.error("Failed to save range collection:", err);
    } finally {
      setRangeSaving(false);
    }
  }, [rangeSaveName, rangeStart, rangeEnd, queryClient]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
      {/* Header + Mode toggle + Range selector */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl text-text-primary">History</h2>
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {(["apps", "timeline"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md transition-colors capitalize",
                  m === mode
                    ? "bg-accent/15 text-accent font-medium"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                {m === "apps" ? "Apps" : "Timeline"}
              </button>
            ))}
          </div>
          {mode === "timeline" && (
            <button
              onClick={() => {
                setRangeSelectMode((prev) => {
                  if (prev) {
                    setRangeStart(null);
                    setRangeEnd(null);
                    setShowRangeNameInput(false);
                    setRangeSaveName("");
                  }
                  return !prev;
                });
              }}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border transition-colors",
                rangeSelectMode
                  ? "bg-accent/15 border-accent/50 text-accent font-medium"
                  : "border-border/50 text-text-muted hover:text-text-secondary hover:border-border",
              )}
            >
              <Crosshair className="size-3" />
              Select Range
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
            {RANGE_PRESETS.map((r, i) => (
              <button
                key={r.label}
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
                {r.label}
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

      {activity && activity.total_screenshots > 0 && mode === "apps" && (
        <div className="flex-1 flex flex-col min-h-0 space-y-4">
          {/* Stats */}
          <div className={`grid gap-3 ${rangeDays > 1 ? "grid-cols-2 xl:grid-cols-4" : "grid-cols-3"}`}>
            <StatCard
              label="Screen Time"
              value={formatDuration(totalActiveTime)}
              detail={`${activeBlocks.length} active blocks`}
              accentColor="#22d3ee"
            />
            <StatCard
              label="Captures"
              value={formatNumber(totalCaptures)}
              detail="View in timeline →"
              accentColor="#a78bfa"
              onClick={() => setMode("timeline")}
            />
            <StatCard
              label="Active Apps"
              value={uniqueApps}
              detail={topAppNames}
              accentColor="#34d399"
            />
            {rangeDays > 1 && (
              <StatCard
                label="Avg Daily"
                value={formatDuration(avgDaily)}
                detail={`over ${rangeDays} day${rangeDays > 1 ? "s" : ""}`}
                accentColor="#fb923c"
              />
            )}
          </div>

          {/* Daily Digest — single-day only */}
          {digestDay && (
            <DailyDigestCard
              dateKey={digestDay.dateKey}
              startTime={digestDay.start}
              endTime={digestDay.end}
              isToday={digestDay.isToday}
              defaultExpanded={false}
            />
          )}

          {/* Charts row — compact */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="Screen Time" compact>
              <ScreenTimeChart
                blocks={(end - start) <= 86400 ? chartBlocks : activeBlocks}
                selectedStart={start}
                selectedEnd={end}
              />
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
                        <span className="text-xs text-text-muted font-mono tabular-nums shrink-0 w-12 text-right">
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
                        <ChevronDown className={`size-3.5 transition-transform shrink-0 ${group.titles.length > 0 ? "text-text-muted" : "text-transparent"} ${isOpen ? "rotate-180" : ""}`} strokeWidth={2} />
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

      {activity && activity.total_screenshots > 0 && mode === "timeline" && (
        <div className="flex-1 flex flex-col min-h-0">
          {isLoadingScreenshots ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : dayGroups.length === 0 ? (
            <div className="text-center py-20 text-text-muted text-sm">
              No screenshots found in this time range.
            </div>
          ) : (
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
                    {day.hours.map((group) => {
                      const isOpen = expandedHours.has(group.key);
                      const previews = sampleEvenly(group.entries, 4);
                      const allIds = group.entries.map((e) => e.id);

                      return (
                        <div key={group.key} className={cn(
                          "border rounded-lg overflow-hidden transition-colors",
                          isHourInRange(group.key)
                            ? "border-accent/50 border-l-2 border-l-accent"
                            : "border-border/50",
                        )}>
                          {/* Hour header */}
                          <div className="flex items-center">
                            <button
                              onClick={() => {
                                if (rangeSelectMode) {
                                  handleRangeClick(hourKeyToTimestamp(group.key));
                                } else {
                                  toggleHour(group.key);
                                }
                              }}
                              className={cn(
                                "flex-1 min-w-0 flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised/40 transition-colors text-left",
                                rangeSelectMode && "cursor-crosshair",
                              )}
                            >
                              <ChevronRight className={cn(
                                  "size-3.5 text-text-muted transition-transform shrink-0",
                                  isOpen && "rotate-90",
                                )} strokeWidth={2} />
                              <span className="text-sm text-text-primary font-medium font-mono tabular-nums">
                                {group.label}
                              </span>
                              <span className="text-xs text-text-muted">
                                {group.entries.length} capture{group.entries.length !== 1 ? "s" : ""}
                              </span>
                              {group.topApps.length > 0 && (
                                <span className="text-xs text-text-muted truncate">
                                  {group.topApps.join(", ")}
                                </span>
                              )}
                              <span className="flex-1" />
                              {/* Preview thumbnails (collapsed only) */}
                              {!isOpen && (
                                <div className="flex gap-1.5 shrink-0">
                                  {previews.map((entry) => (
                                    <div
                                      key={entry.id}
                                      className="w-16 h-10 rounded overflow-hidden bg-surface-raised border border-border/30"
                                    >
                                      {entry.thumbnail_path ? (
                                        <img
                                          src={getImageUrl(entry.thumbnail_path)}
                                          alt=""
                                          className="w-full h-full object-cover"
                                          loading="lazy"
                                        />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                          <span className="text-[8px] text-text-muted font-mono">
                                            {new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </button>
                            {/* Save as collection button */}
                            {saveCollectionKey === group.key ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  handleSaveAsCollection(group);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="flex items-center gap-1.5 px-2 shrink-0"
                              >
                                <input
                                  autoFocus
                                  value={saveCollectionName}
                                  onChange={(e) => setSaveCollectionName(e.target.value)}
                                  placeholder="Collection name..."
                                  className="text-xs bg-transparent border border-border/50 rounded px-2 py-1 w-36 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
                                />
                                <button
                                  type="submit"
                                  disabled={!saveCollectionName.trim() || savingCollection}
                                  className="text-accent hover:text-accent/80 text-xs font-medium disabled:opacity-40 transition-colors"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { setSaveCollectionKey(null); setSaveCollectionName(""); }}
                                  className="text-text-muted hover:text-text-secondary text-xs transition-colors"
                                >
                                  Cancel
                                </button>
                              </form>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSaveCollectionKey(group.key);
                                  setSaveCollectionName(group.label);
                                }}
                                className="px-2 py-2.5 text-text-muted/60 hover:text-accent transition-colors shrink-0"
                                title={`Save ${group.label} as collection`}
                              >
                                <FolderPlus className="size-4" strokeWidth={1.5} />
                              </button>
                            )}
                            {/* Delete hour button */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteKey(group.key);
                              }}
                              className="px-3 py-2.5 text-red-400/60 hover:text-red-400 transition-colors shrink-0"
                              title={`Delete all captures from ${group.label}`}
                            >
                              <Trash2 className="size-4" strokeWidth={1.5} />
                            </button>
                          </div>

                          {/* Expanded grid */}
                          {isOpen && (() => {
                            const INITIAL_LIMIT = 30;
                            const showAll = showAllHours.has(group.key);
                            const visible = showAll ? group.entries : group.entries.slice(0, INITIAL_LIMIT);
                            const remaining = group.entries.length - INITIAL_LIMIT;

                            return (
                              <div className="px-4 pb-3 pt-1">
                                <div className="grid grid-cols-4 xl:grid-cols-6 gap-2">
                                  {visible.map((entry) => (
                                    <button
                                      key={entry.id}
                                      onClick={() => {
                                        if (rangeSelectMode) {
                                          handleRangeClick(entry.timestamp);
                                        } else {
                                          onSelectScreenshot?.(entry.id, allIds);
                                        }
                                      }}
                                      className={cn(
                                        "group relative aspect-video rounded-lg overflow-hidden bg-surface-raised transition-all",
                                        rangeSelectMode
                                          ? isEntryInRange(entry.timestamp)
                                            ? "ring-2 ring-accent border border-accent/50"
                                            : "border border-border/30 hover:border-accent/50 cursor-crosshair"
                                          : "border border-border/30 hover:border-accent/50 hover:scale-[1.02]",
                                      )}
                                    >
                                      {entry.thumbnail_path ? (
                                        <img
                                          src={getImageUrl(entry.thumbnail_path)}
                                          alt=""
                                          className="w-full h-full object-cover opacity-75 group-hover:opacity-100 transition-opacity"
                                          loading="lazy"
                                        />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                          <span className="text-[9px] text-text-muted font-mono">No preview</span>
                                        </div>
                                      )}
                                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2 py-1.5">
                                        <span className="text-[10px] text-white/90 font-mono tabular-nums">
                                          {new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                        </span>
                                        {entry.app_name && (
                                          <span className="text-[9px] text-white/50 ml-1.5">{entry.app_name}</span>
                                        )}
                                      </div>
                                    </button>
                                  ))}
                                </div>
                                {!showAll && remaining > 0 && (
                                  <button
                                    onClick={() =>
                                      setShowAllHours((prev) => {
                                        const next = new Set(prev);
                                        next.add(group.key);
                                        return next;
                                      })
                                    }
                                    className="mt-2 w-full py-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-colors"
                                  >
                                    Load {remaining} more screenshot{remaining !== 1 ? "s" : ""}
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Range selection floating toolbar */}
          {rangeSelectMode && rangeStart !== null && (
            <div className="shrink-0 border-t border-border/50 bg-surface-base/95 backdrop-blur-sm px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Crosshair className="size-3.5 text-accent shrink-0" />
                  <span className="text-sm text-text-secondary">
                    {rangeEnd !== null ? (
                      <>Selected: <span className="text-text-primary font-medium">{rangeDisplayText}</span></>
                    ) : (
                      <span className="text-text-muted">{rangeDisplayText}</span>
                    )}
                  </span>
                </div>
                {showRangeNameInput ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleRangeSaveAsCollection();
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      autoFocus
                      value={rangeSaveName}
                      onChange={(e) => setRangeSaveName(e.target.value)}
                      placeholder="Collection name..."
                      className="text-xs bg-transparent border border-border/50 rounded px-2 py-1.5 w-44 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
                    />
                    <button
                      type="submit"
                      disabled={!rangeSaveName.trim() || rangeSaving}
                      className="text-accent hover:text-accent/80 text-xs font-medium disabled:opacity-40 transition-colors"
                    >
                      {rangeSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowRangeNameInput(false); setRangeSaveName(""); }}
                      className="text-text-muted hover:text-text-secondary text-xs transition-colors"
                    >
                      Back
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (rangeEnd !== null) {
                          const sd = new Date(rangeStart * 1000);
                          const ed = new Date(rangeEnd * 1000);
                          const tf = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                          setRangeSaveName(`${tf(sd)} — ${tf(ed)}`);
                        }
                        setShowRangeNameInput(true);
                      }}
                      disabled={rangeEnd === null}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <FolderPlus className="size-3" />
                      Save as Collection
                    </button>
                    <button
                      onClick={() => { setRangeStart(null); setRangeEnd(null); setShowRangeNameInput(false); }}
                      className="px-2.5 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                      Clear
                    </button>
                    <button
                      onClick={() => {
                        setRangeSelectMode(false);
                        setRangeStart(null);
                        setRangeEnd(null);
                        setShowRangeNameInput(false);
                        setRangeSaveName("");
                      }}
                      className="p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                      title="Exit range select"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
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
