import type { SearchFilters } from "./api";

export const queryKeys = {
  search: (query: string, filters: SearchFilters) =>
    ["search", query, filters] as const,
  screenshot: (id: number) => ["screenshot", id] as const,
  screenshotsByIds: (ids: number[]) => ["screenshots-by-ids", ...ids] as const,
  daemonStatus: () => ["daemon-status"] as const,
  appNames: () => ["app-names"] as const,
  activity: (sinceTimestamp: number, untilTimestamp?: number) =>
    ["activity", sinceTimestamp, untilTimestamp] as const,
  timeline: (startTime: number) => ["timeline", startTime] as const,
  dailySummary: (dateKey: string) => ["daily-summary", dateKey] as const,
  ollamaHealth: () => ["ollama-health"] as const,
  claudeStatus: () => ["claude-status"] as const,
  hourlyBrowse: (startTime: number, endTime: number) =>
    ["hourly-browse", startTime, endTime] as const,
  rewind: (start: number, end: number) => ["rewind", start, end] as const,
  isBookmarked: (id: number) => ["is-bookmarked", id] as const,
  bookmarks: () => ["bookmarks"] as const,
  bookmarkedIds: (ids: number[]) => ["bookmarked-ids", ...ids] as const,
  collections: () => ["collections"] as const,
  collectionScreenshots: (id: number) =>
    ["collection-screenshots", id] as const,
  journalEntry: (date: string) => ["journal-entry", date] as const,
  journalDates: (start: string, end: string) =>
    ["journal-dates", start, end] as const,
  journalStreak: () => ["journal-streak"] as const,
  journalScreenshots: (entryId: number) =>
    ["journal-screenshots", entryId] as const,
  journalTags: (entryId: number) =>
    ["journal-tags", entryId] as const,
  allJournalTags: () => ["all-journal-tags"] as const,
  journalSearch: (query: string) =>
    ["journal-search", query] as const,
  journalSummary: (periodType: string, periodKey: string) =>
    ["journal-summary", periodType, periodKey] as const,
  taskBreakdown: (start: number, end: number, limit: number) =>
    ["taskBreakdown", start, end, limit] as const,
  activeBlocks: (start: number, end: number) =>
    ["activeBlocks", start, end] as const,
  activeBlocksChart: (start: number, end: number) =>
    ["activeBlocks-chart", start, end] as const,
  journalPicker: (start: number, end: number) =>
    ["journal-picker", start, end] as const,
  openTodos: (start: string, end: string) =>
    ["open-todos", start, end] as const,
  config: () => ["config"] as const,
  chats: () => ["chats"] as const,
  chatMessages: (chatId: number) => ["chat-messages", chatId] as const,
  chatSearch: (query: string) => ["chat-search", query] as const,
  ollamaModels: (baseUrl: string) => ["ollama-models", baseUrl] as const,
};
