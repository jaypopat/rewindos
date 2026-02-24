import { todayRange, lastNHours } from "@/lib/time-ranges";
import { getAppColor } from "@/lib/app-colors";
import type { TimelineEntry } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RewindViewProps {
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

export interface ActivitySegment {
  startTime: number;
  endTime: number;
  appName: string;
  color: string;
  startIdx: number;
  endIdx: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TIME_RANGES = [
  { label: "Today", getRange: () => todayRange(0) },
  { label: "Yesterday", getRange: () => todayRange(1) },
  { label: "1h", getRange: () => lastNHours(1) },
  { label: "4h", getRange: () => lastNHours(4) },
  { label: "24h", getRange: () => lastNHours(24) },
] as const;

export const SPEEDS = [1, 2, 5, 10] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatTimeShort(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${ampm}`;
}

export function formatHourLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const h = d.getHours();
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

/** Binary search -- find nearest screenshot index for a given timestamp. */
export function findNearest(screenshots: TimelineEntry[], timestamp: number): number {
  if (screenshots.length === 0) return 0;
  let lo = 0;
  let hi = screenshots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (screenshots[mid].timestamp < timestamp) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const d1 = Math.abs(screenshots[lo].timestamp - timestamp);
    const d0 = Math.abs(screenshots[lo - 1].timestamp - timestamp);
    if (d0 < d1) return lo - 1;
  }
  return lo;
}

/** Build activity segments from consecutive screenshots. */
export function buildSegments(screenshots: TimelineEntry[]): ActivitySegment[] {
  if (screenshots.length === 0) return [];
  const segments: ActivitySegment[] = [];
  let seg: ActivitySegment = {
    startTime: screenshots[0].timestamp,
    endTime: screenshots[0].timestamp,
    appName: screenshots[0].app_name ?? "Unknown",
    color: getAppColor(screenshots[0].app_name),
    startIdx: 0,
    endIdx: 0,
  };

  for (let i = 1; i < screenshots.length; i++) {
    const s = screenshots[i];
    const gap = s.timestamp - seg.endTime;
    const sameApp = (s.app_name ?? "Unknown") === seg.appName;

    if (sameApp && gap < 60) {
      seg.endTime = s.timestamp;
      seg.endIdx = i;
    } else {
      segments.push(seg);
      seg = {
        startTime: s.timestamp,
        endTime: s.timestamp,
        appName: s.app_name ?? "Unknown",
        color: getAppColor(s.app_name),
        startIdx: i,
        endIdx: i,
      };
    }
  }
  segments.push(seg);
  return segments;
}
