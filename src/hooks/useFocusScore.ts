import { useEffect, useState } from "react";
import { browseScreenshots, getConfig } from "@/lib/api";
import { type AppConfig } from "@/lib/config";
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
        // Get capture interval from config (default 5s)
        let captureIntervalSecs = 5;
        try {
          const config = await getConfig() as unknown as AppConfig;
          if (config.capture?.interval_seconds) {
            captureIntervalSecs = config.capture.interval_seconds;
          }
        } catch {
          // Use default
        }

        // Get today's screenshots
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const todayStart = Math.floor(now.getTime() / 1000);

        const screenshots = await browseScreenshots(todayStart, undefined, undefined, 2000);

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

        // Top app
        const topApp =
          Object.entries(appMinutes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

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
