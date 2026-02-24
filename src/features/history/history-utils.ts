import { parseWindowTitle } from "@/lib/window-title";
import { formatSecs } from "@/lib/format";
import type { TaskUsageStat, TimelineEntry } from "@/lib/api";

// Re-export formatSecs for consumers that used the local version
export { formatSecs };

export type HistoryMode = "apps" | "timeline";

export interface HistoryViewProps {
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

export interface AppTaskGroup {
  appName: string;
  totalSeconds: number;
  titles: { title: string; seconds: number }[];
}

export interface HourGroup {
  /** Hour key like "2026-02-13T14" for sorting/uniqueness */
  key: string;
  /** Display label like "14:00 -- 15:00" */
  label: string;
  /** All entries in this hour, sorted by timestamp */
  entries: TimelineEntry[];
  /** Top app names for the summary */
  topApps: string[];
}

export interface DayGroup {
  /** Date string like "2026-02-13" */
  date: string;
  /** Display label like "Thursday, Feb 13" */
  label: string;
  /** Hour groups within this day */
  hours: HourGroup[];
  /** Total screenshots this day */
  totalEntries: number;
}

export function groupTasksByApp(tasks: TaskUsageStat[]): AppTaskGroup[] {
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

export function groupByDay(entries: TimelineEntry[]): DayGroup[] {
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
      const label = `${String(hour).padStart(2, "0")}:00 \u2014 ${String(nextHour).padStart(2, "0")}:00`;

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
export function sampleEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

export function hourKeyToTimestamp(key: string): number {
  const datePart = key.slice(0, 10);
  const hourNum = parseInt(key.slice(-2), 10);
  const d = new Date(`${datePart}T${String(hourNum).padStart(2, "0")}:00:00`);
  return Math.floor(d.getTime() / 1000);
}

export const RANGE_PRESETS = [
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

export function getRangeForDate(dateStr: string): { start: number; end: number } {
  const d = new Date(dateStr + "T00:00:00");
  const start = Math.floor(d.getTime() / 1000);
  return { start, end: start + 86400 };
}
