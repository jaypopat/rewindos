import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getActivity,
  getTaskBreakdown,
  getActiveBlocks,
  browseScreenshots,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { groupTasksByApp, groupByDay } from "../history-utils";

export function useHistoryData(start: number, end: number, mode: "apps" | "timeline") {
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

  // Active blocks (selected range -- for stats)
  const { data: activeBlocks = [] } = useQuery({
    queryKey: ["activeBlocks", start, end],
    queryFn: () => getActiveBlocks(start, end),
    staleTime: 60_000,
  });

  // Active blocks (last 14 days -- for chart context)
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

  return {
    activity,
    isLoading,
    taskStats,
    activeBlocks,
    chartBlocks,
    screenshots,
    isLoadingScreenshots,
    dayGroups,
    totalScreenTime,
    totalActiveTime,
    appGroups,
    totalCaptures,
    uniqueApps,
    topAppNames,
    avgDaily,
    digestDay,
    rangeDays,
  };
}
