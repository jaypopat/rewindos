import { useEffect, useState } from "react";
import { browseScreenshots, getDaemonStatus, type DaemonStatus } from "@/lib/api";
import { categorizeApp } from "@/lib/app-categories";

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

export function useFocusScore(
  distractionApps: string[],
  categoryRules?: Record<string, string[]>,
): FocusMetrics {
  const [metrics, setMetrics] = useState<FocusMetrics>({
    focusScore: 0,
    appSwitches: 0,
    distractionMinutes: 0,
    productiveMinutes: 0,
    topApp: null,
    categoryBreakdown: {},
    sessionCount: 0,
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function compute() {
      try {
        // Get today's screenshots
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const todayStart = Math.floor(now.getTime() / 1000);

        const [screenshots, _status] = await Promise.all([
          browseScreenshots(todayStart, undefined, undefined, 2000),
          getDaemonStatus().catch(() => null as DaemonStatus | null),
        ]);

        if (cancelled) return;

        if (screenshots.length === 0) {
          setMetrics({
            focusScore: 0,
            appSwitches: 0,
            distractionMinutes: 0,
            productiveMinutes: 0,
            topApp: null,
            categoryBreakdown: {},
            sessionCount: 0,
            isLoading: false,
          });
          return;
        }

        // Count app switches and category breakdown
        let switches = 0;
        let prevApp: string | null = null;
        const appMinutes: Record<string, number> = {};
        const categoryMinutes: Record<string, number> = {};
        let distractionCount = 0;
        const distractSet = new Set(distractionApps.map((a) => a.toLowerCase()));

        for (const ss of screenshots) {
          const app = ss.app_name ?? "Unknown";
          if (prevApp !== null && app !== prevApp) {
            switches++;
          }
          prevApp = app;

          // 5 seconds per screenshot
          const mins = 5 / 60;
          appMinutes[app] = (appMinutes[app] ?? 0) + mins;

          const category = categorizeApp(ss.app_name, categoryRules);
          categoryMinutes[category] = (categoryMinutes[category] ?? 0) + mins;

          if (distractSet.has(app.toLowerCase())) {
            distractionCount++;
          }
        }

        // Round category minutes
        for (const key of Object.keys(categoryMinutes)) {
          categoryMinutes[key] = Math.round(categoryMinutes[key]);
        }

        const distractionMinutes = Math.round((distractionCount * 5) / 60);
        const totalMinutes = Math.round((screenshots.length * 5) / 60);
        const productiveMinutes = totalMinutes - distractionMinutes;

        // Focus score: penalize app switches and distraction time
        // Base: 100, -1 per switch (past 10/hour threshold), -2 per distraction minute
        const hours = Math.max(totalMinutes / 60, 0.5);
        const switchRate = switches / hours;
        const switchPenalty = Math.max(0, (switchRate - 10) * 1.5);
        const distractionPenalty = distractionMinutes * 2;
        const focusScore = Math.max(0, Math.min(100, Math.round(100 - switchPenalty - distractionPenalty)));

        // Top app
        const topApp = Object.entries(appMinutes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

        // Count sessions (consecutive runs of the same app)
        const sessionCount = switches + (screenshots.length > 0 ? 1 : 0);

        setMetrics({
          focusScore,
          appSwitches: switches,
          distractionMinutes,
          productiveMinutes,
          topApp,
          categoryBreakdown: categoryMinutes,
          sessionCount,
          isLoading: false,
        });
      } catch {
        if (!cancelled) {
          setMetrics((prev) => ({ ...prev, isLoading: false }));
        }
      }
    }

    compute();

    // Refresh every 30s
    const interval = setInterval(compute, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [distractionApps, categoryRules]);

  return metrics;
}
