import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  browseScreenshots,
  getActivity,
  getConfig,
  getImageUrl,
  getTaskBreakdown,
  getActiveBlocks,
  type TaskUsageStat,
  type TimelineEntry,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useFocusScore } from "@/hooks/useFocusScore";
import { formatDuration } from "@/lib/format";
import { StatCard } from "./StatCard";
import { AppDot } from "./AppDot";
import { getAppColor } from "@/lib/app-colors";
import { HourlyActivityChart } from "./charts/HourlyActivityChart";
import { AppDonutChart } from "./charts/AppDonutChart";
import { buildCategoryRules, getCategoryColor, type ActivityCategory } from "@/lib/app-categories";
import { parseWindowTitle } from "@/lib/window-title";

interface DashboardViewProps {
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

function formatMins(mins: number): string {
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

function formatSecs(secs: number): string {
  return formatMins(Math.round(secs / 60));
}

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function computeTrend(today: number, yesterday: number): number {
  if (yesterday <= 0) return 0;
  return Math.round(((today - yesterday) / yesterday) * 100);
}

// Build colored app spans from screenshot data
interface AppSpan {
  appName: string;
  startTime: number;
  endTime: number;
}

function buildAppSpans(screenshots: TimelineEntry[]): AppSpan[] {
  if (screenshots.length === 0) return [];

  const sorted = [...screenshots].sort((a, b) => a.timestamp - b.timestamp);
  const spans: AppSpan[] = [];
  let current: AppSpan = {
    appName: sorted[0].app_name ?? "Unknown",
    startTime: sorted[0].timestamp,
    endTime: sorted[0].timestamp + 5,
  };

  for (let i = 1; i < sorted.length; i++) {
    const ss = sorted[i];
    const app = ss.app_name ?? "Unknown";
    const gap = ss.timestamp - current.endTime;

    if (app === current.appName && gap < 30) {
      current.endTime = ss.timestamp + 5;
    } else {
      spans.push(current);
      current = {
        appName: app,
        startTime: ss.timestamp,
        endTime: ss.timestamp + 5,
      };
    }
  }
  spans.push(current);
  return spans;
}

// Top tasks: top N apps with their #1 window title
interface TopTask {
  appName: string;
  totalSeconds: number;
  topTitle: string | null;
}

function getTopTasks(tasks: TaskUsageStat[], limit: number): TopTask[] {
  const map = new Map<string, { total: number; titles: Map<string, number> }>();
  for (const t of tasks) {
    const entry = map.get(t.app_name) ?? { total: 0, titles: new Map() };
    entry.total += t.estimated_seconds;
    if (t.window_title) {
      const parsed = parseWindowTitle(t.window_title, t.app_name);
      entry.titles.set(parsed, (entry.titles.get(parsed) ?? 0) + t.estimated_seconds);
    }
    map.set(t.app_name, entry);
  }
  return [...map.entries()]
    .map(([appName, { total, titles }]) => {
      const topEntry = [...titles.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        appName,
        totalSeconds: total,
        topTitle: topEntry ? topEntry[0] : null,
      };
    })
    .filter((t) => t.totalSeconds >= 30) // hide <30s entries
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, limit);
}

// App-colored timeline — dynamic range based on actual activity
function AppTimeline({
  spans,
  todayStart,
}: {
  spans: AppSpan[];
  todayStart: number;
}) {
  // Compute range from actual data: earliest span to now (or latest span + pad)
  const now = Math.floor(Date.now() / 1000);
  const earliest = spans.reduce((min, s) => Math.min(min, s.startTime), spans[0].startTime);
  const latest = spans.reduce((max, s) => Math.max(max, s.endTime), spans[0].endTime);

  // Round down to even hour for start, round up for end
  const earliestHour = Math.floor((earliest - todayStart) / 3600);
  const latestHour = Math.ceil((Math.max(latest, now) - todayStart) / 3600) + 1;

  const startHour = Math.max(0, earliestHour - (earliestHour % 2)); // align to even
  const endHour = Math.min(24, latestHour + (latestHour % 2)); // align to even
  const totalHours = Math.max(endHour - startHour, 2);

  const rangeStart = todayStart + startHour * 3600;
  const rangeEnd = todayStart + endHour * 3600;

  const hourLabels = [];
  const step = totalHours <= 8 ? 1 : 2;
  for (let h = startHour; h <= endHour; h += step) {
    hourLabels.push(h);
  }

  return (
    <div className="border border-border/50 px-4 py-3">
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
        Today's Timeline
      </h3>
      <div className="relative">
        <div className="flex justify-between mb-1">
          {hourLabels.map((h) => (
            <span
              key={h}
              className="text-[10px] text-text-muted font-mono"
              style={{ width: `${(step / totalHours) * 100}%` }}
            >
              {formatHour(h % 24)}
            </span>
          ))}
        </div>
        <div className="relative h-6 bg-surface-raised rounded overflow-hidden">
          {spans.map((span, i) => {
            const blockStart = Math.max(span.startTime, rangeStart);
            const blockEnd = Math.min(span.endTime, rangeEnd);
            if (blockEnd <= rangeStart || blockStart >= rangeEnd) return null;
            const left = ((blockStart - rangeStart) / (rangeEnd - rangeStart)) * 100;
            const width = ((blockEnd - blockStart) / (rangeEnd - rangeStart)) * 100;
            return (
              <div
                key={i}
                className="absolute top-0 h-full rounded-sm"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.3)}%`,
                  backgroundColor: getAppColor(span.appName),
                  opacity: 0.8,
                }}
                title={`${span.appName}: ${new Date(blockStart * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(blockEnd * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${formatSecs(blockEnd - blockStart)})`}
              />
            );
          })}
          {/* Current time marker */}
          {now >= rangeStart && now <= rangeEnd && (
            <div
              className="absolute top-0 h-full w-px bg-red-400/60"
              style={{ left: `${((now - rangeStart) / (rangeEnd - rangeStart)) * 100}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Single-row carousel with left/right arrows
function CapturesCarousel({
  captures,
  onSelect,
}: {
  captures: TimelineEntry[];
  onSelect: (id: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState, captures]);

  const scroll = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll by ~3 card widths
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
          Today's Captures
        </h2>
        <div className="flex items-center gap-2">
          {/* Arrow buttons */}
          <button
            onClick={() => scroll(-1)}
            disabled={!canScrollLeft}
            className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-20 disabled:cursor-default transition-colors"
            aria-label="Scroll left"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <button
            onClick={() => scroll(1)}
            disabled={!canScrollRight}
            className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-20 disabled:cursor-default transition-colors"
            aria-label="Scroll right"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>
          <span className="text-[10px] text-text-muted font-mono tabular-nums">
            {captures.length} captures
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto scroll-smooth [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:hidden"
      >
        {captures.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className="group relative shrink-0 w-56 aspect-video overflow-hidden rounded-lg border border-border/30 hover:border-accent/50 bg-surface-raised transition-all hover:scale-[1.02]"
          >
            <img
              src={getImageUrl(s.thumbnail_path!)}
              alt=""
              className="w-full h-full object-cover opacity-75 group-hover:opacity-100 transition-opacity"
              loading="lazy"
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2 py-1.5">
              <span className="text-[10px] text-white/90 font-mono tabular-nums">
                {new Date(s.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              {s.app_name && (
                <span className="text-[9px] text-white/50 ml-1.5">{s.app_name}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

export function DashboardView({ onSelectScreenshot }: DashboardViewProps) {
  const [distractionApps, setDistractionApps] = useState<string[]>([]);
  const [categoryRules, setCategoryRules] = useState<Record<string, string[]> | undefined>();

  // Load focus config
  useEffect(() => {
    getConfig()
      .then((c) => {
        const focus = c.focus as Record<string, unknown> | undefined;
        if (focus) {
          setDistractionApps((focus.distraction_apps as string[]) ?? []);
          const userRules = (focus.category_rules ?? {}) as Record<string, string[]>;
          if (Object.keys(userRules).length > 0) {
            setCategoryRules(buildCategoryRules(userRules));
          }
        }
      })
      .catch(() => {});
  }, []);

  // Today's time range
  const { todayStart, todayEnd } = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const start = Math.floor(d.getTime() / 1000);
    return { todayStart: start, todayEnd: start + 86400 };
  }, []);

  // Yesterday's time range
  const { yesterdayStart, yesterdayEnd } = useMemo(() => {
    return { yesterdayStart: todayStart - 86400, yesterdayEnd: todayStart };
  }, [todayStart]);

  // ---- Data fetching ----

  const { data: todayActivity } = useQuery({
    queryKey: queryKeys.activity(todayStart),
    queryFn: () => getActivity(todayStart),
    staleTime: 30_000,
  });

  const { data: screenshots = [], isLoading: screenshotsLoading } = useQuery({
    queryKey: queryKeys.timeline(todayStart),
    queryFn: () => browseScreenshots(todayStart, todayEnd, undefined, 2000),
    staleTime: 30_000,
  });

  const { data: taskStats = [] } = useQuery({
    queryKey: ["taskBreakdown", todayStart, todayEnd],
    queryFn: () => getTaskBreakdown(todayStart, todayEnd, 200),
    staleTime: 30_000,
  });

  const { data: activeBlocks = [] } = useQuery({
    queryKey: ["activeBlocks", todayStart, todayEnd],
    queryFn: () => getActiveBlocks(todayStart, todayEnd),
    staleTime: 30_000,
  });

  const { data: yesterdayActiveBlocks = [] } = useQuery({
    queryKey: ["activeBlocks", yesterdayStart, yesterdayEnd],
    queryFn: () => getActiveBlocks(yesterdayStart, yesterdayEnd),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const focus = useFocusScore(distractionApps, categoryRules);

  // ---- Derived data ----

  const totalScreenTime = useMemo(
    () => taskStats.reduce((sum, t) => sum + t.estimated_seconds, 0),
    [taskStats],
  );

  const totalActiveTime = useMemo(
    () => activeBlocks.reduce((sum, b) => sum + b.duration_secs, 0),
    [activeBlocks],
  );

  const yesterdayActiveTime = useMemo(
    () => yesterdayActiveBlocks.reduce((sum, b) => sum + b.duration_secs, 0),
    [yesterdayActiveBlocks],
  );

  const activeTimeTrend = computeTrend(totalActiveTime, yesterdayActiveTime);

  const appSpans = useMemo(() => buildAppSpans(screenshots), [screenshots]);

  const topTasks = useMemo(() => getTopTasks(taskStats, 5), [taskStats]);

  const categoryEntries = useMemo(() => {
    return Object.entries(focus.categoryBreakdown)
      .filter(([, mins]) => mins > 0)
      .sort((a, b) => b[1] - a[1]) as [ActivityCategory, number][];
  }, [focus.categoryBreakdown]);

  const totalCategoryMins = useMemo(
    () => categoryEntries.reduce((sum, [, mins]) => sum + mins, 0),
    [categoryEntries],
  );

  // Sample screenshots evenly across the day for the captures grid
  const sampledCaptures = useMemo(() => {
    const withThumbs = screenshots.filter((s) => s.thumbnail_path);
    if (withThumbs.length === 0) return [];
    const count = 15;
    if (withThumbs.length <= count) return withThumbs;
    const sorted = [...withThumbs].sort((a, b) => a.timestamp - b.timestamp);
    const step = (sorted.length - 1) / (count - 1);
    return Array.from({ length: count }, (_, i) => sorted[Math.round(i * step)]);
  }, [screenshots]);

  // ---- Render ----

  return (
    <div className="flex-1 flex flex-col overflow-y-auto px-5 py-4 gap-4">

      {/* Header */}
      <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
        Overview
      </h2>

      {/* Stats row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard
          label="Screen Time"
          value={screenshotsLoading ? "\u2014" : formatDuration(totalActiveTime)}
          trend={activeTimeTrend}
          trendLabel="vs yesterday"
          accentColor="#22d3ee"
        />
        <StatCard
          label="Captures"
          value={screenshotsLoading ? "\u2014" : String(todayActivity?.total_screenshots ?? 0)}
          detail="screenshots today"
          accentColor="#a78bfa"
        />
        <StatCard
          label="Focus Score"
          value={focus.isLoading ? "\u2014" : String(focus.focusScore)}
          detail="/100"
          accentColor={focus.focusScore >= 70 ? "#34d399" : focus.focusScore >= 40 ? "#fbbf24" : "#f87171"}
        />
        <StatCard
          label="Top App"
          value={focus.isLoading ? "\u2014" : (focus.topApp ?? "\u2014")}
          detail="most used today"
          accentColor="#fb923c"
        />
      </div>

      {/* App-colored timeline */}
      {appSpans.length > 0 && (
        <AppTimeline spans={appSpans} todayStart={todayStart} />
      )}

      {/* Two-column: Top Tasks + Hourly Activity */}
      {(topTasks.length > 0 || (todayActivity && todayActivity.total_screenshots > 0)) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* Top Tasks */}
          {topTasks.length > 0 && (
            <section className="flex flex-col">
              <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
                Top Tasks
              </h2>
              <div className="border border-border/50 divide-y divide-border/30 flex-1">
                {topTasks.map((task) => {
                  const pct = totalScreenTime > 0 ? (task.totalSeconds / totalScreenTime) * 100 : 0;
                  return (
                    <div key={task.appName} className="flex items-center gap-3 px-4 py-2.5">
                      <AppDot appName={task.appName} size={8} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-text-primary">{task.appName}</span>
                        {task.topTitle && (
                          <span className="text-xs text-text-muted ml-2 truncate">
                            {task.topTitle}
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-text-muted font-mono tabular-nums shrink-0">
                        {formatSecs(task.totalSeconds)}
                      </span>
                      <div className="w-20 h-1.5 bg-surface-raised rounded-full shrink-0 overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: getAppColor(task.appName),
                            opacity: 0.8,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Hourly Activity */}
          {todayActivity && todayActivity.total_screenshots > 0 && (
            <section className="flex flex-col">
              <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
                Hourly Activity
              </h2>
              <div className="border border-border/50 p-3 flex-1 flex items-end">
                <HourlyActivityChart data={todayActivity.hourly_activity} height={160} />
              </div>
            </section>
          )}
        </div>
      )}

      {/* Two-column: Categories + Focus / App Usage */}
      {(categoryEntries.length > 0 || todayActivity) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* Categories + Focus Stats */}
          {categoryEntries.length > 0 && totalCategoryMins > 0 && (
            <section className="border border-border/50 px-4 py-3 flex flex-col gap-4">
              {/* Category bar + legend */}
              <div>
                <div className="flex items-center gap-4 mb-3">
                  <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] shrink-0">
                    Categories
                  </h2>
                  <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-raised flex-1">
                    {categoryEntries.map(([cat, mins]) => (
                      <div
                        key={cat}
                        className="h-full first:rounded-l-full last:rounded-r-full"
                        style={{
                          width: `${(mins / totalCategoryMins) * 100}%`,
                          backgroundColor: getCategoryColor(cat),
                          opacity: 0.85,
                        }}
                        title={`${cat}: ${formatMins(mins)}`}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-5 flex-wrap">
                  {categoryEntries.map(([cat, mins]) => {
                    const pct = Math.round((mins / totalCategoryMins) * 100);
                    return (
                      <div key={cat} className="flex items-center gap-1.5">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: getCategoryColor(cat) }}
                        />
                        <span className="text-xs text-text-secondary">{cat}</span>
                        <span className="text-[10px] text-text-muted font-mono tabular-nums">
                          {formatMins(mins)} ({pct}%)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Focus stats row */}
              <div className="border-t border-border/30 pt-3 grid grid-cols-3 gap-3">
                <div>
                  <span className="text-[10px] text-text-muted uppercase tracking-wider block mb-0.5">App Switches</span>
                  <span className="text-lg text-text-primary font-display leading-none">{focus.appSwitches}</span>
                  <span className="text-[10px] text-text-muted ml-1">today</span>
                </div>
                <div>
                  <span className="text-[10px] text-text-muted uppercase tracking-wider block mb-0.5">Sessions</span>
                  <span className="text-lg text-text-primary font-display leading-none">{focus.sessionCount}</span>
                  <span className="text-[10px] text-text-muted ml-1">blocks</span>
                </div>
                <div>
                  <span className="text-[10px] text-text-muted uppercase tracking-wider block mb-0.5">Productive</span>
                  <span className="text-lg text-text-primary font-display leading-none">{focus.productiveMinutes}m</span>
                  <span className="text-[10px] text-text-muted ml-1">
                    / {focus.productiveMinutes + focus.distractionMinutes}m
                  </span>
                </div>
              </div>
            </section>
          )}

          {/* App Usage Donut */}
          {todayActivity && todayActivity.app_usage.length > 0 && (
            <section className="border border-border/50 px-4 py-3 flex flex-col">
              <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-3">
                App Usage
              </h2>
              <div className="flex-1 flex items-center">
                <AppDonutChart data={todayActivity.app_usage} />
              </div>
            </section>
          )}
        </div>
      )}

      {/* Today's Captures — single-row carousel */}
      {sampledCaptures.length > 0 && (
        <CapturesCarousel
          captures={sampledCaptures}
          onSelect={(id) => onSelectScreenshot(id, sampledCaptures.map(c => c.id))}
        />
      )}

      {/* Empty state */}
      {!screenshotsLoading && screenshots.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <p className="text-sm text-text-secondary">No activity recorded today</p>
            <p className="text-xs text-text-muted">Start the daemon to begin capturing</p>
          </div>
        </div>
      )}
    </div>
  );
}
