import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  browseScreenshots,
  getActivity,
  getConfig,
  getTaskBreakdown,
  getActiveBlocks,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { type AppConfig } from "@/lib/config";
import { formatDuration } from "@/lib/format";
import { buildCategoryRules, categorizeApp, type ActivityCategory } from "@/lib/app-categories";
import { StatCard } from "@/components/StatCard";
import { HourlyActivityChart } from "@/components/charts/HourlyActivityChart";
import { AppDonutChart } from "@/components/charts/AppDonutChart";
import { AppTimeline } from "./AppTimeline";
import { CapturesCarousel } from "./CapturesCarousel";
import { TopTasksList } from "./TopTasksList";
import { CategoriesBreakdown } from "./CategoriesBreakdown";
import { buildAppSpans, computeTrend, getTopTasks } from "./dashboard-utils";

export interface DashboardViewProps {
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

export function DashboardView({ onSelectScreenshot }: DashboardViewProps) {
  const [categoryRules, setCategoryRules] = useState<Record<string, string[]> | undefined>();

  // Load category config
  useEffect(() => {
    getConfig()
      .then((c) => {
        const { focus } = c as unknown as AppConfig;
        if (focus) {
          const userRules = focus.category_rules ?? {};
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
    queryKey: queryKeys.activity(todayStart, todayEnd),
    queryFn: () => getActivity(todayStart, todayEnd),
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

  const topApp = useMemo(() => {
    if (topTasks.length === 0) return null;
    return topTasks[0].appName;
  }, [topTasks]);

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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
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
          label="Active Apps"
          value={screenshotsLoading ? "\u2014" : String(new Set(taskStats.map(t => t.app_name)).size)}
          detail={topApp ? `Top: ${topApp}` : undefined}
          accentColor="#34d399"
        />
        <StatCard
          label="Top App"
          value={topApp ?? "\u2014"}
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Top Tasks */}
          {topTasks.length > 0 && (
            <TopTasksList tasks={topTasks} totalScreenTime={totalScreenTime} />
          )}

          {/* Hourly Activity */}
          {todayActivity && todayActivity.total_screenshots > 0 && (
            <section className="flex flex-col min-h-0">
              <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
                Hourly Activity
              </h2>
              <div className="border border-border/50 p-3 flex-1 flex items-end min-h-[200px]">
                <HourlyActivityChart data={todayActivity.hourly_activity} />
              </div>
            </section>
          )}
        </div>
      )}

      {/* Two-column: Categories + App Usage */}
      {(categoryEntries.length > 0 || todayActivity) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Categories */}
          {categoryEntries.length > 0 && totalCategoryMins > 0 && (
            <CategoriesBreakdown entries={categoryEntries} totalMins={totalCategoryMins} />
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
