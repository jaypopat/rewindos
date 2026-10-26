import type { ActivityResponse } from "@/lib/api";

/** True when the range has screenshots or usage-only app time. */
export function hasActivity(a: ActivityResponse): boolean {
  return a.total_screenshots > 0 || a.total_active_seconds > 0;
}
