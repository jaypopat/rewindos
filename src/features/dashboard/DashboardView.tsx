import { useCallback, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Search } from "lucide-react";
import {
  browseScreenshots,
  getActivity,
  getTaskBreakdown,
  getActiveBlocks,
  getImageUrl,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import {
  buildCategoryRules,
  categorizeApp,
  getCategoryColor,
  type ActivityCategory,
} from "@/lib/app-categories";
import { formatMins } from "@/lib/format";
import { useConfigQuery } from "@/hooks/useConfigQuery";
import { Rise, CountNum } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { ScrollHint } from "@/components/ScrollHint";
import { EditorialBarChart } from "@/components/charts/EditorialBarChart";
import { DayRibbon } from "./DayRibbon";
import { TopAppsLedger } from "./TopAppsLedger";
import {
  buildAppSpans,
  computeBaselineAverage,
  computeTrend,
  getTopTasks,
} from "./dashboard-utils";

export interface DashboardViewProps {
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
  onRewindToRange?: (start: number, end: number) => void;
  onGoToSearch?: () => void;
}

export function DashboardView({
  onSelectScreenshot,
  onRewindToRange,
  onGoToSearch,
}: DashboardViewProps) {
  const { data: appConfig } = useConfigQuery();

  const categoryRules = useMemo(() => {
    const userRules = appConfig?.focus?.category_rules;
    if (userRules && Object.keys(userRules).length > 0) {
      return buildCategoryRules(userRules);
    }
    return undefined;
  }, [appConfig]);

  // Today's time range
  const { todayStart, todayEnd } = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const start = Math.floor(d.getTime() / 1000);
    return { todayStart: start, todayEnd: start + 86400 };
  }, []);

  // Last 28 days before today — covers 4 prior same-weekdays for the baseline
  const { baselineStart, baselineEnd } = useMemo(() => {
    return { baselineStart: todayStart - 86400 * 28, baselineEnd: todayStart };
  }, [todayStart]);

  // ---- Data fetching ----

  const { data: todayActivity } = useQuery({
    queryKey: queryKeys.activity(todayStart, todayEnd),
    queryFn: () => getActivity(todayStart, todayEnd),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: baselineActivity } = useQuery({
    queryKey: queryKeys.activity(baselineStart, baselineEnd),
    queryFn: () => getActivity(baselineStart, baselineEnd),
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  const { data: screenshots = [], isLoading: screenshotsLoading } = useQuery({
    queryKey: queryKeys.timeline(todayStart),
    queryFn: () => browseScreenshots(todayStart, todayEnd, undefined, 2000),
    staleTime: 30_000,
  });

  const { data: taskStats = [] } = useQuery({
    queryKey: queryKeys.taskBreakdown(todayStart, todayEnd, 200),
    queryFn: () => getTaskBreakdown(todayStart, todayEnd, 200),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: activeBlocks = [] } = useQuery({
    queryKey: queryKeys.activeBlocks(todayStart, todayEnd),
    queryFn: () => getActiveBlocks(todayStart, todayEnd),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: baselineActiveBlocks = [] } = useQuery({
    queryKey: queryKeys.activeBlocks(baselineStart, baselineEnd),
    queryFn: () => getActiveBlocks(baselineStart, baselineEnd),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // ---- Derived data ----

  const capturesToday = todayActivity?.total_screenshots ?? 0;

  // Captures vs the average active day in the last 4 weeks
  const capturesTrend = useMemo(() => {
    const days = (baselineActivity?.daily_activity ?? []).filter((d) => d.screenshot_count > 0);
    if (days.length < 2 || capturesToday === 0) return null;
    const avg = days.reduce((s, d) => s + d.screenshot_count, 0) / days.length;
    return computeTrend(capturesToday, avg);
  }, [baselineActivity, capturesToday]);

  const totalActiveTime = useMemo(
    () => activeBlocks.reduce((sum, b) => sum + b.duration_secs, 0),
    [activeBlocks],
  );

  const totalScreenTime = useMemo(
    () => taskStats.reduce((sum, t) => sum + t.estimated_seconds, 0),
    [taskStats],
  );

  const longestBlock = useMemo(
    () => activeBlocks.reduce((max, b) => Math.max(max, b.duration_secs), 0),
    [activeBlocks],
  );

  const { average: baselineAverage, label: baselineLabel } = useMemo(
    () => computeBaselineAverage(baselineActiveBlocks, baselineStart),
    [baselineActiveBlocks, baselineStart],
  );

  const activeTimeTrend = computeTrend(totalActiveTime, baselineAverage);

  const appSpans = useMemo(() => buildAppSpans(screenshots), [screenshots]);

  const topTasks = useMemo(() => getTopTasks(taskStats, 6), [taskStats]);

  const appsUsed = useMemo(
    () => new Set(taskStats.map((t) => t.app_name)).size,
    [taskStats],
  );

  const hourly = useMemo(() => {
    const byHour = new Map(
      (todayActivity?.hourly_activity ?? []).map((h) => [h.hour, h.screenshot_count]),
    );
    const lastHour = new Date().getHours();
    return Array.from({ length: lastHour + 1 }, (_, h) => ({
      label: `${String(h).padStart(2, "0")}:00`,
      value: byHour.get(h) ?? 0,
    }));
  }, [todayActivity]);

  const peakHour = useMemo(() => {
    if (hourly.length === 0) return null;
    const peak = hourly.reduce((a, b) => (b.value > a.value ? b : a), hourly[0]);
    return peak.value > 0 ? peak.label : null;
  }, [hourly]);

  const categoryEntries = useMemo(() => {
    const catMins: Record<string, number> = {};
    for (const t of taskStats) {
      const cat = categorizeApp(t.app_name, categoryRules);
      const mins = Math.round(t.estimated_seconds / 60);
      catMins[cat] = (catMins[cat] ?? 0) + mins;
    }
    return Object.entries(catMins)
      .filter(([, mins]) => mins > 0)
      .sort((a, b) => b[1] - a[1]) as [ActivityCategory, number][];
  }, [taskStats, categoryRules]);

  const totalCategoryMins = useMemo(
    () => categoryEntries.reduce((sum, [, mins]) => sum + mins, 0),
    [categoryEntries],
  );

  // Sampled evenly across the day, not most-recent: consecutive captures are
  // near-duplicates, so the last N frames would all show the same minute.
  const dayFrames = useMemo(() => {
    const withThumbs = screenshots
      .filter((s) => s.thumbnail_path)
      .sort((a, b) => a.timestamp - b.timestamp);
    const count = 12;
    if (withThumbs.length <= count) return withThumbs;
    const step = (withThumbs.length - 1) / (count - 1);
    return Array.from({ length: count }, (_, i) => withThumbs[Math.round(i * step)]);
  }, [screenshots]);

  // Ribbon click: open the frame nearest the picked time, with the whole
  // day as siblings so ←/→ steps through it (Rewind stays one click away).
  const openFrameAt = useCallback(
    (ts: number) => {
      const sorted = [...screenshots].sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length === 0) return;
      let best = sorted[0];
      for (const s of sorted) {
        if (Math.abs(s.timestamp - ts) < Math.abs(best.timestamp - ts)) best = s;
      }
      onSelectScreenshot(best.id, sorted.map((s) => s.id));
    },
    [screenshots, onSelectScreenshot],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  const now = Math.floor(Date.now() / 1000);
  const dateLine = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const stats: { label: string; value: React.ReactNode; note?: React.ReactNode }[] = [
    {
      label: "Moments captured",
      value: <CountNum value={capturesToday} className="num text-3xl" />,
      note:
        capturesTrend != null && capturesTrend !== 0 ? (
          <span
            className={`font-mono text-[10px] ${capturesTrend > 0 ? "text-signal-active" : "text-accent"}`}
          >
            {capturesTrend > 0 ? "▲" : "▼"} {Math.abs(capturesTrend)}% vs your average
          </span>
        ) : undefined,
    },
    {
      label: "Applications",
      value: <CountNum value={appsUsed} className="num text-3xl" />,
    },
    {
      label: "Longest block",
      value: (
        <span className="num text-3xl">
          {longestBlock > 0 ? formatDuration(longestBlock) : "—"}
        </span>
      ),
    },
    {
      label: "Peak hour",
      value: <span className="num text-3xl">{peakHour ?? "—"}</span>,
    },
  ];

  // ---- Render ----

  if (!screenshotsLoading && screenshots.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-center">
        <div>
          <h3 className="font-display text-2xl mb-2.5">A quiet page, so far.</h3>
          <p className="text-sm text-text-muted max-w-[380px] leading-relaxed">
            No activity recorded today — start the daemon and this becomes your daily
            briefing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 relative">
      <div ref={scrollRef} className="@container h-full overflow-y-auto">
        <div className="px-5 @4xl:px-14 pt-11 pb-24 max-w-[1320px] mx-auto w-full">
        {/* Hero — the daily briefing */}
        <div className="grid grid-cols-1 @4xl:grid-cols-[1.1fr_1fr] gap-10 @4xl:gap-16 items-start @4xl:items-end pb-9 border-b border-line">
          <div>
            <Rise i={0}>
              <div className="font-mono text-[11.5px] uppercase tracking-[0.16em] text-text-muted mb-[18px]">
                {dateLine} — daily briefing
              </div>
            </Rise>
            <Rise i={1} className="flex items-baseline gap-4">
              <CountNum
                value={totalActiveTime}
                format={(v) => (screenshotsLoading ? "—" : formatDuration(Math.round(v)))}
                className="num whitespace-nowrap text-[64px] @4xl:text-[92px] leading-[0.85]"
              />
              <div className="pb-2 flex flex-wrap items-baseline gap-x-2.5">
                <div className="font-display text-[21px] text-text-secondary">
                  on screen today
                </div>
                {baselineAverage > 0 && activeTimeTrend !== 0 && (
                  <div
                    className={`font-mono text-[11px] whitespace-nowrap ${activeTimeTrend > 0 ? "text-signal-active" : "text-accent"}`}
                  >
                    {activeTimeTrend > 0 ? "▲" : "▼"} {Math.abs(activeTimeTrend)}% {baselineLabel}
                  </div>
                )}
              </div>
            </Rise>
            <Rise i={2} className="flex gap-2.5 mt-[26px]">
              <Button
                variant="default"
                onClick={() => onRewindToRange?.(todayStart, now)}
                className="inline-flex items-center gap-2 h-9 px-[15px] rounded-lg text-[13px] font-semibold bg-accent text-[#1c1208] border border-accent-deep hover:bg-accent-hi"
              >
                <Play className="size-[15px] fill-current" strokeWidth={0} />
                Rewind the day
              </Button>
              <Button
                variant="outline"
                onClick={() => onGoToSearch?.()}
                className="inline-flex items-center gap-2 h-9 px-[15px] rounded-lg text-[13px] font-medium border border-line-2 hover:border-line-hi hover:bg-panel"
              >
                <Search className="size-[15px]" strokeWidth={1.7} />
                Search
              </Button>
            </Rise>
          </div>
          <div className="grid grid-cols-2 gap-x-10 gap-y-[26px]">
            {stats.map((s, idx) => (
              <Rise key={s.label} i={3 + idx}>
                <div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-muted mb-2">
                  {s.label}
                </div>
                {s.value}
                {s.note && <div className="mt-1.5">{s.note}</div>}
              </Rise>
            ))}
          </div>
        </div>

        {/* The day, end to end */}
        {appSpans.length > 0 && (
          <div className="mt-11">
            <Rise i={7} className="flex items-baseline gap-3.5 mb-6">
              <h2 className="font-display text-[23px] tracking-tight">The day, end to end</h2>
              <div className="ml-auto font-mono text-[11px] text-text-muted">
                hover to scrub · click to open that moment
                {peakHour ? ` · peak ${peakHour}` : ""}
              </div>
            </Rise>
            <DayRibbon spans={appSpans} onPickMoment={openFrameAt} />
          </div>
        )}

        {/* Where the time went — categories as one stacked strip */}
        {categoryEntries.length > 0 && totalCategoryMins > 0 && (
          <div className="mt-11">
            <Rise i={8} className="flex items-baseline gap-3.5 mb-5">
              <h2 className="font-display text-[23px] tracking-tight">Where the time went</h2>
              <div className="ml-auto font-mono text-[11px] text-text-muted">
                {formatMins(totalCategoryMins)} categorised
              </div>
            </Rise>
            <div className="flex h-1.5 rounded-sm overflow-hidden bg-line-2">
              {categoryEntries.map(([cat, mins], i) => (
                <Rise
                  key={cat}
                  kind="draw"
                  i={9 + i}
                  step={40}
                  style={{
                    width: `${(mins / totalCategoryMins) * 100}%`,
                    background: getCategoryColor(cat),
                    opacity: 0.75,
                  }}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3.5">
              {categoryEntries.map(([cat, mins]) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-muted"
                >
                  <span
                    className="size-2 rounded-[2px]"
                    style={{ background: getCategoryColor(cat) }}
                  />
                  {cat}
                  <span className="text-text-faint normal-case">{formatMins(mins)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Top applications + captures per hour */}
        <div className="grid grid-cols-1 @4xl:grid-cols-[1fr_1.3fr] gap-10 @4xl:gap-14 mt-14">
          <div>
            <Rise i={10} className="flex items-baseline mb-6">
              <h2 className="font-display text-[23px] tracking-tight">Top applications</h2>
            </Rise>
            <TopAppsLedger
              apps={topTasks}
              categoryFor={(app) => categorizeApp(app, categoryRules)}
              totalSeconds={totalScreenTime}
              riseBase={11}
            />
          </div>
          <div>
            <Rise i={10} className="flex items-baseline gap-3.5 mb-6">
              <h2 className="font-display text-[23px] tracking-tight">Captures per hour</h2>
              {peakHour && (
                <div className="ml-auto font-mono text-[11px] text-text-muted">
                  today · peak {peakHour}
                </div>
              )}
            </Rise>
            <Rise i={11}>
              <EditorialBarChart data={hourly} />
            </Rise>
          </div>
        </div>

        {/* The day in frames */}
        {dayFrames.length > 0 && (
          <div className="mt-14">
            <Rise i={12} className="flex items-baseline gap-3.5 mb-6">
              <h2 className="font-display text-[23px] tracking-tight">The day in frames</h2>
              <div className="ml-auto font-mono text-[11px] text-text-muted">
                sampled across today · click to open
              </div>
            </Rise>
            <div className="grid grid-cols-2 @lg:grid-cols-3 @4xl:grid-cols-6 gap-3.5">
              {dayFrames.map((c, idx) => (
                <Rise
                  key={c.id}
                  i={13 + idx}
                  className="cursor-pointer group"
                  onClick={() =>
                    onSelectScreenshot(c.id, dayFrames.map((f) => f.id))
                  }
                >
                  <div className="h-[100px] rounded-[6px] overflow-hidden bg-panel border border-black/40 group-hover:border-line-hi transition-colors">
                    <img
                      src={getImageUrl(c.thumbnail_path!)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </div>
                  <div className="mt-2 text-[12.5px] font-[450] truncate">
                    {c.window_title ?? c.app_name ?? "Untitled"}
                  </div>
                  <div className="font-mono text-[10px] text-text-faint mt-0.5">
                    {c.app_name ?? "unknown"} · {formatRelativeTime(c.timestamp)}
                  </div>
                </Rise>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>
      <ScrollHint scrollRef={scrollRef} />
    </div>
  );
}
