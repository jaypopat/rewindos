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
): Promise<ActivityResponse> {
  return invoke("get_activity", { sinceTimestamp });
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
  summary: string;
  app_breakdown: AppTimeEntry[];
  total_sessions: number;
  time_range: string;
}

export async function getDailySummary(
  startTime: number,
  endTime: number,
): Promise<DailySummary> {
  return invoke("get_daily_summary", { startTime, endTime });
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

// -- Settings --

export async function getConfig(): Promise<Record<string, unknown>> {
  return invoke("get_config");
}

export async function updateConfig(
  config: Record<string, unknown>,
): Promise<void> {
  return invoke("update_config", { configJson: config });
}
