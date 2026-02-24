import { format } from "date-fns";

export function dateToKey(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function dayStartEnd(d: Date): [number, number] {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)];
}

export function todayRange(daysAgo: number): { start: number; end: number } {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  const start = Math.floor(d.getTime() / 1000);
  const end = daysAgo === 0 ? Math.floor(Date.now() / 1000) : start + 86400;
  return { start, end };
}

export function lastNHours(n: number): { start: number; end: number } {
  const now = Math.floor(Date.now() / 1000);
  return { start: now - n * 3600, end: now };
}

export function dateStringToRange(dateStr: string): { start: number; end: number } {
  const d = new Date(dateStr + "T00:00:00");
  const start = Math.floor(d.getTime() / 1000);
  return { start, end: start + 86400 };
}
