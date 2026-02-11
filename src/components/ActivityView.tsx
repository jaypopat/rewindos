import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActivity, getDaemonStatus } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { formatNumber, formatBytes, formatDuration } from "@/lib/format";
import { StatCard } from "./StatCard";
import { HeatmapCalendar } from "./charts/HeatmapCalendar";
import { AppDonutChart } from "./charts/AppDonutChart";
import { WeeklyHeatmap } from "./charts/WeeklyHeatmap";
import { DailyActivityChart } from "./charts/DailyActivityChart";
import { HourlyActivityChart } from "./charts/HourlyActivityChart";
import { cn } from "@/lib/utils";

const RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

export function ActivityView() {
  const [rangeIdx, setRangeIdx] = useState(0);
  const range = RANGES[rangeIdx];
  // Stable timestamp: only recompute when range changes, snapped to start-of-day
  const sinceTimestamp = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - range.days * 86400;
  }, [range.days]);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.activity(sinceTimestamp),
    queryFn: () => getActivity(sinceTimestamp),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: daemonStatus } = useQuery({
    queryKey: queryKeys.daemonStatus(),
    queryFn: getDaemonStatus,
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-xl text-text-primary">Observatory</h2>
          {data && (
            <p className="text-xs text-text-muted mt-0.5">
              {formatNumber(data.total_screenshots)} captures across {data.total_apps} apps
            </p>
          )}
        </div>
        <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
          {RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIdx(i)}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                i === rangeIdx
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-text-muted hover:text-text-secondary"
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

      {isError && (
        <div className="text-center py-20 text-text-muted text-sm">
          Failed to load activity data. Make sure the daemon is running.
        </div>
      )}

      {data && data.total_screenshots === 0 && (
        <div className="text-center py-20 text-text-muted text-sm">
          No captures in the last {range.label}. Start the daemon to begin recording.
        </div>
      )}

      {data && data.total_screenshots > 0 && (
        <>
          {/* Row 1: Stat cards */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <StatCard
              label="Screen Time"
              value={formatDuration(data.total_screenshots * 5)}
              sparklineData={data.daily_activity.slice(-7).map((d) => d.screenshot_count * 5)}
              detail={`${formatNumber(data.total_screenshots)} captures`}
              accentColor="#22d3ee"
            />
            <StatCard
              label="Active Apps"
              value={data.total_apps}
              detail={data.app_usage.slice(0, 3).map((a) => a.app_name).join(", ")}
              accentColor="#a78bfa"
            />
            <StatCard
              label="Disk Usage"
              value={formatBytes(daemonStatus?.disk_usage_bytes ?? 0)}
              detail={daemonStatus ? `${formatDuration(daemonStatus.uptime_seconds)} uptime` : undefined}
              accentColor="#34d399"
            />
            <StatCard
              label="Dedup Rate"
              value={
                daemonStatus && daemonStatus.frames_captured_today > 0
                  ? `${Math.round((daemonStatus.frames_deduplicated_today / daemonStatus.frames_captured_today) * 100)}%`
                  : "—"
              }
              detail={
                daemonStatus
                  ? `${daemonStatus.frames_deduplicated_today} of ${daemonStatus.frames_captured_today} today`
                  : undefined
              }
              accentColor="#fb923c"
            />
          </div>

          {/* Row 2: Heatmap calendar */}
          <ChartCard title="Capture Activity">
            <HeatmapCalendar
              data={data.daily_activity.map((d) => ({
                date: d.date,
                count: d.screenshot_count,
                uniqueApps: d.unique_apps,
              }))}
              weeks={Math.min(Math.ceil(range.days / 7) + 1, 16)}
            />
          </ChartCard>

          {/* Row 3: Two panels */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="App Usage">
              <AppDonutChart data={data.app_usage} />
            </ChartCard>
            <ChartCard title="Weekly Pattern">
              <WeeklyHeatmap data={data.hourly_activity} />
            </ChartCard>
          </div>

          {/* Row 4: Full-width charts */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="Daily Trend">
              <DailyActivityChart data={data.daily_activity} />
            </ChartCard>
            <ChartCard title="Hourly Distribution">
              <HourlyActivityChart data={data.hourly_activity} />
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

function ChartCard({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface-raised rounded-xl border border-border/50 p-4 ${className}`}>
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
        {title}
      </h3>
      {children}
    </div>
  );
}
