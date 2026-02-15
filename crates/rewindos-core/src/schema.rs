use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// -- Database model types --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Screenshot {
    pub id: i64,
    pub timestamp: i64,
    pub timestamp_ms: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_class: Option<String>,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub width: i32,
    pub height: i32,
    pub file_size_bytes: i64,
    pub perceptual_hash: Vec<u8>,
    pub ocr_status: OcrStatus,
    pub created_at: String,
}

/// Insert DTO — fields needed to create a new screenshot record.
#[derive(Debug, Clone)]
pub struct NewScreenshot {
    pub timestamp: i64,
    pub timestamp_ms: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_class: Option<String>,
    pub file_path: String,
    pub thumbnail_path: Option<String>,
    pub width: i32,
    pub height: i32,
    pub file_size_bytes: i64,
    pub perceptual_hash: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrText {
    pub id: i64,
    pub screenshot_id: i64,
    pub text_content: String,
    pub word_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub id: i64,
    pub screenshot_id: i64,
    pub text_content: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: Option<f64>,
}

/// Bounding box insert DTO (no id).
#[derive(Debug, Clone)]
pub struct NewBoundingBox {
    pub text_content: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: i64,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub thumbnail_path: Option<String>,
    pub file_path: String,
    pub matched_text: String,
    pub rank: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_screenshot_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchFilters {
    #[serde(default)]
    pub query: String,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub app_name: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub is_capturing: bool,
    pub frames_captured_today: u64,
    pub frames_deduplicated_today: u64,
    pub frames_ocr_pending: u64,
    pub queue_depths: QueueDepths,
    pub uptime_seconds: u64,
    pub disk_usage_bytes: u64,
    pub capture_interval: u32,
    pub last_capture_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueDepths {
    pub capture: u64,
    pub hash: u64,
    pub ocr: u64,
    pub index: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrStatus {
    Pending,
    Processing,
    Done,
    Failed,
}

impl OcrStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            OcrStatus::Pending => "pending",
            OcrStatus::Processing => "processing",
            OcrStatus::Done => "done",
            OcrStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "processing" => OcrStatus::Processing,
            "done" => OcrStatus::Done,
            "failed" => OcrStatus::Failed,
            _ => OcrStatus::Pending,
        }
    }
}

// -- Activity / analytics types --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppUsageStat {
    pub app_name: String,
    pub screenshot_count: i64,
    pub percentage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyActivity {
    pub date: String,
    pub screenshot_count: i64,
    pub unique_apps: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyActivity {
    pub hour: i32,
    pub screenshot_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityResponse {
    pub app_usage: Vec<AppUsageStat>,
    pub daily_activity: Vec<DailyActivity>,
    pub hourly_activity: Vec<HourlyActivity>,
    pub total_screenshots: i64,
    pub total_apps: i64,
}

// -- Task breakdown / active blocks --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUsageStat {
    pub app_name: String,
    pub window_title: Option<String>,
    pub screenshot_count: i64,
    pub estimated_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveBlock {
    pub start_time: i64,
    pub end_time: i64,
    pub duration_secs: i64,
}

// -- Pipeline types (for future capture pipeline use) --

#[derive(Debug, Clone)]
pub struct RawFrame {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_class: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProcessedFrame {
    pub screenshot_id: i64,
    pub file_path: PathBuf,
    pub thumbnail_path: PathBuf,
    pub timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct OcrResult {
    pub screenshot_id: i64,
    pub full_text: String,
    pub bounding_boxes: Vec<NewBoundingBox>,
}

#[derive(Debug, Clone)]
pub struct EmbedRequest {
    pub screenshot_id: i64,
    pub text: String,
}

// -- Daily summary cache --

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedDailySummary {
    pub date_key: String,
    pub summary_text: Option<String>,
    pub app_breakdown: String, // JSON array of {app_name, minutes, session_count}
    pub total_sessions: i64,
    pub time_range: String,
    pub model_name: Option<String>,
    pub generated_at: String,
    pub screenshot_count: i64,
}
