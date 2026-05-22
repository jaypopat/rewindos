import { parseWindowTitle } from "@/lib/window-title";
import type { ActiveBlock, TaskUsageStat, TimelineEntry } from "@/lib/api";

export function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

export function computeTrend(today: number, yesterday: number): number {
  if (yesterday <= 0) return 0;
  return Math.round(((today - yesterday) / yesterday) * 100);
}

// Prefer same-weekday comparison (screen time is weekly-periodic); fall back to
// any-day average, then yesterday, when there isn't enough history yet.
// `baselineStart` must be exactly 28 days (4 weeks) before today so indices
// 0/7/14/21 align with today's weekday.
export function computeBaselineAverage(
  blocks: ActiveBlock[],
  baselineStart: number,
): { average: number; label: string } {
  const perDay = new Map<number, number>();
  for (const b of blocks) {
    const dayIdx = Math.floor((b.start_time - baselineStart) / 86400);
    perDay.set(dayIdx, (perDay.get(dayIdx) ?? 0) + b.duration_secs);
  }
  const sameWeekday = [0, 7, 14, 21]
    .map((i) => perDay.get(i) ?? 0)
    .filter((s) => s > 0);
  if (sameWeekday.length >= 2) {
    const avg = sameWeekday.reduce((s, v) => s + v, 0) / sameWeekday.length;
    return { average: avg, label: `vs ${sameWeekday.length}-wk avg` };
  }
  const activeDays = [...perDay.values()].filter((s) => s > 0);
  if (activeDays.length >= 2) {
    const avg = activeDays.reduce((s, v) => s + v, 0) / activeDays.length;
    return { average: avg, label: `vs ${activeDays.length}d avg` };
  }
  return { average: perDay.get(27) ?? 0, label: "vs yesterday" };
}

// Build colored app spans from screenshot data
export interface AppSpan {
  appName: string;
  startTime: number;
  endTime: number;
}

export function buildAppSpans(screenshots: TimelineEntry[]): AppSpan[] {
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
export interface TopTask {
  appName: string;
  totalSeconds: number;
  topTitle: string | null;
}

export function getTopTasks(tasks: TaskUsageStat[], limit: number): TopTask[] {
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
