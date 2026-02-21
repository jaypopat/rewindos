import type { SearchFilters } from "./api";

export const queryKeys = {
  search: (query: string, filters: SearchFilters) =>
    ["search", query, filters] as const,
  screenshot: (id: number) => ["screenshot", id] as const,
  daemonStatus: () => ["daemon-status"] as const,
  appNames: () => ["app-names"] as const,
  activity: (sinceTimestamp: number, untilTimestamp?: number) =>
    ["activity", sinceTimestamp, untilTimestamp] as const,
  timeline: (startTime: number) => ["timeline", startTime] as const,
  dailySummary: (dateKey: string) => ["daily-summary", dateKey] as const,
  askHealth: () => ["ask-health"] as const,
  hourlyBrowse: (startTime: number, endTime: number) =>
    ["hourly-browse", startTime, endTime] as const,
  rewind: (start: number, end: number) => ["rewind", start, end] as const,
  isBookmarked: (id: number) => ["is-bookmarked", id] as const,
  bookmarks: () => ["bookmarks"] as const,
  bookmarkedIds: (ids: number[]) => ["bookmarked-ids", ...ids] as const,
  collections: () => ["collections"] as const,
  collectionScreenshots: (id: number) =>
    ["collection-screenshots", id] as const,
};
