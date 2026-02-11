import type { SearchFilters } from "./api";

export const queryKeys = {
  search: (query: string, filters: SearchFilters) =>
    ["search", query, filters] as const,
  screenshot: (id: number) => ["screenshot", id] as const,
  daemonStatus: () => ["daemon-status"] as const,
  appNames: () => ["app-names"] as const,
  activity: (sinceTimestamp: number) => ["activity", sinceTimestamp] as const,
  timeline: (startTime: number) => ["timeline", startTime] as const,
  dailySummary: (startTime: number) => ["daily-summary", startTime] as const,
  askHealth: () => ["ask-health"] as const,
};
