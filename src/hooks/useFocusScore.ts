import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { browseScreenshots, type TimelineEntry } from "@/lib/api";
import { categorizeApp } from "@/lib/app-categories";
import { useConfigQuery } from "./useConfigQuery";

export interface FocusMetrics {
  focusScore: number; // 0-100
  appSwitches: number;
  distractionMinutes: number;
  productiveMinutes: number;
  topApp: string | null;
  categoryBreakdown: Record<string, number>; // category → minutes
  sessionCount: number;
  isLoading: boolean;
}

const EMPTY_METRICS: FocusMetrics = {
  focusScore: 0,
  appSwitches: 0,
  distractionMinutes: 0,
  productiveMinutes: 0,
  topApp: null,
  categoryBreakdown: {},
  sessionCount: 0,
  isLoading: true,
};

function todayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function computeMetrics(
  screenshots: TimelineEntry[],
  distractionApps: string[],
  categoryRules: Record<string, string[]> | undefined,
  captureIntervalSecs: number,
): Omit<FocusMetrics, "isLoading"> {
  if (screenshots.length === 0) {
    return {
      focusScore: 0,
      appSwitches: 0,
      distractionMinutes: 0,
      productiveMinutes: 0,
      topApp: null,
      categoryBreakdown: {},
      sessionCount: 0,
    };
  }

  // Count app switches and build time estimates using actual timestamps
  // where possible, falling back to capture interval for isolated captures.
  let switches = 0;
  let prevApp: string | null = null;
  const appMinutes: Record<string, number> = {};
  const categoryMinutes: Record<string, number> = {};
  let distractionSecs = 0;
  const distractSet = new Set(distractionApps.map((a) => a.toLowerCase()));

  for (let i = 0; i < screenshots.length; i++) {
    const ss = screenshots[i];
    const app = ss.app_name ?? "Unknown";

    if (prevApp !== null && app !== prevApp) {
      switches++;
    }
    prevApp = app;

    // Attribute time: if gap to next screenshot is small (<60s), use
    // the actual gap. Otherwise use the configured capture interval.
    let secs = captureIntervalSecs;
    if (i + 1 < screenshots.length) {
      const gap = Math.abs(screenshots[i].timestamp - screenshots[i + 1].timestamp);
      if (gap > 0 && gap < 60) {
        secs = gap;
      }
    }
    const mins = secs / 60;

    appMinutes[app] = (appMinutes[app] ?? 0) + mins;

    const category = categorizeApp(ss.app_name, categoryRules);
    categoryMinutes[category] = (categoryMinutes[category] ?? 0) + mins;

    if (distractSet.has(app.toLowerCase())) {
      distractionSecs += secs;
    }
  }

  // Round category minutes (preserve 1 minute minimum for small values)
  for (const key of Object.keys(categoryMinutes)) {
    const raw = categoryMinutes[key];
    categoryMinutes[key] = raw >= 0.5 ? Math.round(raw) : raw > 0 ? 1 : 0;
  }

  const distractionMinutes = Math.round(distractionSecs / 60);
  const totalMinutes = Math.round(
    Object.values(appMinutes).reduce((a, b) => a + b, 0),
  );
  const productiveMinutes = Math.max(0, totalMinutes - distractionMinutes);

  // Focus score formula:
  //
  // Start at 100, then apply penalties:
  //   switchPenalty  = max(0, (switches/hour - 10)) * 1.5  (excess switches above 10/hr)
  //   distractionPct = distractionMinutes / totalMinutes    (fraction of time distracted)
  //   distractionPenalty = distractionPct * 60              (scales 0-60: 100% distraction → -60)
  //
  // This means even a high-distraction day with lots of productive work
  // doesn't immediately drop to zero — it's proportional.
  const hours = Math.max(totalMinutes / 60, 0.5);
  const switchRate = switches / hours;
  const switchPenalty = Math.max(0, (switchRate - 10) * 1.5);

  const distractionRatio = totalMinutes > 0 ? distractionMinutes / totalMinutes : 0;
  const distractionPenalty = distractionRatio * 60;

  const focusScore = Math.max(
    0,
    Math.min(100, Math.round(100 - switchPenalty - distractionPenalty)),
  );

  const topApp =
    Object.entries(appMinutes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const sessionCount = switches + (screenshots.length > 0 ? 1 : 0);

  return {
    focusScore,
    appSwitches: switches,
    distractionMinutes,
    productiveMinutes,
    topApp,
    categoryBreakdown: categoryMinutes,
    sessionCount,
  };
}

export function useFocusScore(
  distractionApps: string[],
  categoryRules?: Record<string, string[]>,
): FocusMetrics {
  const { data: appConfig } = useConfigQuery();
  const captureInterval = appConfig?.capture?.interval_seconds ?? 5;

  const { data: screenshots, isLoading } = useQuery({
    queryKey: ["focus-screenshots", todayStart()],
    queryFn: () => browseScreenshots(todayStart(), undefined, undefined, 2000),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return useMemo(() => {
    if (isLoading || !screenshots) return EMPTY_METRICS;
    return {
      ...computeMetrics(screenshots, distractionApps, categoryRules, captureInterval),
      isLoading: false,
    };
  }, [screenshots, isLoading, distractionApps, categoryRules, captureInterval]);
}
