import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export interface SearchFilters {
  start_time?: number;
  end_time?: number;
  app_name?: string;
  limit: number;
  offset: number;
}

export interface SearchResult {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  thumbnail_path: string | null;
  file_path: string;
  matched_text: string;
  rank: number;
  group_count?: number;
  group_screenshot_ids?: number[];
}

export interface SearchResponse {
  results: SearchResult[];
  total_count: number;
  search_mode?: string;
}

export interface ScreenshotDetail {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  window_class: string | null;
  file_path: string;
  width: number;
  height: number;
  ocr_text: string | null;
  bounding_boxes: BoundingBox[];
}

export interface BoundingBox {
  id: number;
  screenshot_id: number;
  text_content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number | null;
}

export interface DaemonStatus {
  is_capturing: boolean;
  frames_captured_today: number;
  frames_deduplicated_today: number;
  frames_ocr_pending: number;
  uptime_seconds: number;
  disk_usage_bytes: number;
  last_capture_timestamp: number | null;
}

export async function search(
  query: string,
  filters: SearchFilters,
): Promise<SearchResponse> {
  return invoke("search", { query, filters });
}

export async function getScreenshot(id: number): Promise<ScreenshotDetail> {
  return invoke("get_screenshot", { id });
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return invoke("get_daemon_status");
}

export async function pauseCapture(): Promise<void> {
  return invoke("pause_capture");
}

export async function resumeCapture(): Promise<void> {
  return invoke("resume_capture");
}

export async function getAppNames(): Promise<string[]> {
  return invoke("get_app_names");
}

export interface AppUsageStat {
  app_name: string;
  screenshot_count: number;
  percentage: number;
}

export interface DailyActivity {
  date: string;
  screenshot_count: number;
  unique_apps: number;
}

export interface HourlyActivity {
  hour: number;
  screenshot_count: number;
}

export interface ActivityResponse {
  app_usage: AppUsageStat[];
  daily_activity: DailyActivity[];
  hourly_activity: HourlyActivity[];
  total_screenshots: number;
  total_apps: number;
}

export async function getActivity(
  sinceTimestamp: number,
  untilTimestamp?: number,
): Promise<ActivityResponse> {
  return invoke("get_activity", {
    sinceTimestamp,
    untilTimestamp: untilTimestamp ?? null,
  });
}

export interface TimelineEntry {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  thumbnail_path: string | null;
  file_path: string;
}

export async function browseScreenshots(
  startTime?: number,
  endTime?: number,
  appName?: string,
  limit?: number,
): Promise<TimelineEntry[]> {
  return invoke("browse_screenshots", {
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    appName: appName ?? null,
    limit: limit ?? 200,
  });
}

export interface AppTimeEntry {
  app_name: string;
  minutes: number;
  session_count: number;
}

export interface DailySummary {
  summary: string | null;
  app_breakdown: AppTimeEntry[];
  total_sessions: number;
  time_range: string;
  cached: boolean;
  generated_at: string | null;
  screenshot_count: number;
}

export async function getDailySummary(
  startTime: number,
  endTime: number,
  forceRegenerate?: boolean,
): Promise<DailySummary> {
  return invoke("get_daily_summary", {
    startTime,
    endTime,
    forceRegenerate: forceRegenerate ?? false,
  });
}

export function getImageUrl(path: string): string {
  return convertFileSrc(path);
}

// -- Task breakdown / Active blocks --

export interface TaskUsageStat {
  app_name: string;
  window_title: string | null;
  screenshot_count: number;
  estimated_seconds: number;
}

export interface ActiveBlock {
  start_time: number;
  end_time: number;
  duration_secs: number;
}

export async function getTaskBreakdown(
  startTime: number,
  endTime: number,
  limit?: number,
): Promise<TaskUsageStat[]> {
  return invoke("get_task_breakdown", {
    startTime,
    endTime,
    limit: limit ?? null,
  });
}

export async function getActiveBlocks(
  startTime: number,
  endTime: number,
): Promise<ActiveBlock[]> {
  return invoke("get_active_blocks", { startTime, endTime });
}

// -- Ask / Chat --

export interface ScreenshotRef {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  file_path: string;
}

export interface AskResponse {
  session_id: string;
  references: ScreenshotRef[];
}

export async function askNewSession(): Promise<string> {
  return invoke("ask_new_session");
}

export async function askHealth(): Promise<boolean> {
  return invoke("ask_health");
}

export async function ask(
  sessionId: string,
  message: string,
): Promise<AskResponse> {
  return invoke("ask", { sessionId, message });
}

// -- Delete --

export async function deleteScreenshotsInRange(
  startTime: number,
  endTime: number,
): Promise<number> {
  return invoke("delete_screenshots_in_range", { startTime, endTime });
}

// -- Bookmarks --

export interface BookmarkData {
  id: number;
  screenshot_id: number;
  note: string | null;
  created_at: string;
}

export interface BookmarkEntry {
  bookmark: BookmarkData;
  screenshot: TimelineEntry;
}

export async function toggleBookmark(
  screenshotId: number,
  note?: string,
): Promise<boolean> {
  return invoke("toggle_bookmark", {
    screenshotId,
    note: note ?? null,
  });
}

export async function isBookmarked(screenshotId: number): Promise<boolean> {
  return invoke("is_bookmarked", { screenshotId });
}

export async function getBookmarkedIds(
  screenshotIds: number[],
): Promise<number[]> {
  return invoke("get_bookmarked_ids", { screenshotIds });
}

export async function listBookmarks(
  limit?: number,
  offset?: number,
): Promise<BookmarkEntry[]> {
  return invoke("list_bookmarks", {
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

// -- Collections --

export interface Collection {
  id: number;
  name: string;
  description: string | null;
  color: string;
  start_time: number | null;
  end_time: number | null;
  created_at: string;
  updated_at: string;
  screenshot_count: number;
}

export interface NewCollection {
  name: string;
  description?: string;
  color?: string;
  start_time?: number;
  end_time?: number;
}

export interface UpdateCollectionData {
  name?: string;
  description?: string;
  color?: string;
  start_time?: number;
  end_time?: number;
}

export async function createCollection(
  collection: NewCollection,
): Promise<number> {
  return invoke("create_collection", { collection });
}

export async function updateCollection(
  id: number,
  update: UpdateCollectionData,
): Promise<void> {
  return invoke("update_collection", { id, update });
}

export async function deleteCollection(id: number): Promise<void> {
  return invoke("delete_collection", { id });
}

export async function listCollections(): Promise<Collection[]> {
  return invoke("list_collections");
}

export async function getCollectionScreenshots(
  id: number,
  limit?: number,
  offset?: number,
): Promise<TimelineEntry[]> {
  return invoke("get_collection_screenshots", {
    id,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export async function addToCollection(
  collectionId: number,
  screenshotId: number,
): Promise<void> {
  return invoke("add_to_collection", { collectionId, screenshotId });
}

export async function removeFromCollection(
  collectionId: number,
  screenshotId: number,
): Promise<void> {
  return invoke("remove_from_collection", { collectionId, screenshotId });
}

// -- Journal --

export interface JournalEntry {
  id: number;
  date: string;
  content: string;
  mood: number | null;
  energy: number | null;
  word_count: number;
  created_at: string;
  updated_at: string;
}

export interface JournalScreenshot {
  id: number;
  journal_entry_id: number;
  screenshot_id: number;
  caption: string | null;
  sort_order: number;
  created_at: string;
}

export interface JournalStreakInfo {
  current_streak: number;
  longest_streak: number;
  total_entries: number;
}

export async function getJournalEntry(
  date: string,
): Promise<JournalEntry | null> {
  return invoke("get_journal_entry", { date });
}

export async function upsertJournalEntry(
  entry: { date: string; content: string; mood?: number | null; energy?: number | null },
): Promise<number> {
  return invoke("upsert_journal_entry", { entry });
}

export async function deleteJournalEntry(date: string): Promise<boolean> {
  return invoke("delete_journal_entry", { date });
}

export interface JournalDateInfo {
  date: string;
  word_count: number;
  mood: number | null;
}

export async function getJournalDates(
  startDate: string,
  endDate: string,
): Promise<JournalDateInfo[]> {
  return invoke("get_journal_dates", { startDate, endDate });
}

export async function getJournalStreak(): Promise<JournalStreakInfo> {
  return invoke("get_journal_streak");
}

export async function addJournalScreenshot(
  journalEntryId: number,
  screenshotId: number,
  caption?: string,
): Promise<number> {
  return invoke("add_journal_screenshot", {
    journalEntryId,
    screenshotId,
    caption: caption ?? null,
  });
}

export async function removeJournalScreenshot(
  journalEntryId: number,
  screenshotId: number,
): Promise<void> {
  return invoke("remove_journal_screenshot", {
    journalEntryId,
    screenshotId,
  });
}

export async function getJournalScreenshots(
  journalEntryId: number,
): Promise<JournalScreenshot[]> {
  return invoke("get_journal_screenshots", { journalEntryId });
}

// -- Journal Tags --

export interface JournalTag {
  id: number;
  name: string;
  color: string | null;
  created_at: string;
}

export async function setJournalTags(
  entryId: number,
  tags: string[],
): Promise<void> {
  return invoke("set_journal_tags", { entryId, tags });
}

export async function getJournalTags(
  entryId: number,
): Promise<JournalTag[]> {
  return invoke("get_journal_tags", { entryId });
}

export async function listAllJournalTags(): Promise<JournalTag[]> {
  return invoke("list_all_journal_tags");
}

// -- Journal Search --

export interface JournalSearchResult {
  entry_id: number;
  date: string;
  snippet: string;
  mood: number | null;
  word_count: number;
}

export interface JournalSearchResponse {
  results: JournalSearchResult[];
  total_count: number;
}

export async function searchJournal(
  query: string,
  limit?: number,
  offset?: number,
): Promise<JournalSearchResponse> {
  return invoke("search_journal", {
    query,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

// -- Journal Templates --

export interface JournalTemplate {
  id: number;
  name: string;
  description: string | null;
  content: string;
  is_builtin: boolean;
  sort_order: number;
}

export async function listJournalTemplates(): Promise<JournalTemplate[]> {
  return invoke("list_journal_templates");
}

export async function createJournalTemplate(
  name: string,
  description: string | null,
  content: string,
): Promise<number> {
  return invoke("create_journal_template", { name, description, content });
}

export async function deleteJournalTemplate(id: number): Promise<boolean> {
  return invoke("delete_journal_template", { id });
}

// -- Journal Summary --

export interface JournalSummary {
  period_type: string;
  period_key: string;
  summary_text: string;
  entry_count: number;
  generated_at: string;
  cached: boolean;
}

export async function generateJournalSummary(
  periodType: string,
  periodKey: string,
  startDate: string,
  endDate: string,
  forceRegenerate?: boolean,
): Promise<JournalSummary> {
  return invoke("generate_journal_summary", {
    periodType,
    periodKey,
    startDate,
    endDate,
    forceRegenerate: forceRegenerate ?? false,
  });
}

// -- Journal Export --

export async function exportJournal(
  startDate: string,
  endDate: string,
): Promise<string> {
  return invoke("export_journal", { startDate, endDate });
}

// -- Settings --

export async function getConfig(): Promise<Record<string, unknown>> {
  return invoke("get_config");
}

export async function updateConfig(
  config: Record<string, unknown>,
): Promise<void> {
  return invoke("update_config", { configJson: config });
}
