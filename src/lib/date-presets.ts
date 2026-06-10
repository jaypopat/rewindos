export const DATE_PRESETS = [
  { label: "All", value: undefined },
  { label: "Today", value: () => todayTimestamp() },
  { label: "Yesterday", value: () => todayTimestamp() - 86400 },
  { label: "7d", value: () => todayTimestamp() - 86400 * 7 },
  { label: "30d", value: () => todayTimestamp() - 86400 * 30 },
] as const;

export function todayTimestamp(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor(now.getTime() / 1000);
}
