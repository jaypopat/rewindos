//! rmcp stdio MCP server.
//!
//! Spawned by Claude Code via `rewindos-daemon mcp`. Uses rmcp 1.5's
//! attribute-macro pattern: `#[tool_router]` collects `#[tool]` methods
//! into a router, `#[tool_handler]` wires the router into `ServerHandler`.
//! stdout is the JSON-RPC transport — tracing goes to stderr (set up in
//! `main::run_mcp_server`), never stdout.

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::mcp::{
    get_app_usage, get_recent_activity, get_screenshot_detail, get_timeline, search_screenshots,
    GetAppUsageInput, GetRecentActivityInput, GetScreenshotDetailInput, GetTimelineInput,
    SearchScreenshotsInput,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ErrorData as McpError},
    tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};

#[derive(Clone)]
pub struct RewindosMcpServer {
    // rusqlite's Connection is !Sync (interior RefCell), so we serialize
    // access via a Mutex. Each tool holds the lock only for the duration
    // of a single synchronous DB call — no await while holding it — so
    // std::sync::Mutex is fine.
    db: Arc<Mutex<Database>>,
    capture_interval_seconds: u32,
    // Accessed via #[tool_handler] macro-generated ServerHandler impl.
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl RewindosMcpServer {
    pub fn new(db: Database, capture_interval_seconds: u32) -> Self {
        Self {
            db: Arc::new(Mutex::new(db)),
            capture_interval_seconds,
            tool_router: Self::tool_router(),
        }
    }

    fn ok_json<T: serde::Serialize>(value: &T) -> Result<CallToolResult, McpError> {
        let body = serde_json::to_string(value)
            .map_err(|e| McpError::internal_error(format!("serialize: {e}"), None))?;
        Ok(CallToolResult::success(vec![Content::text(body)]))
    }

    fn lock_err<E: std::fmt::Display>(e: E) -> McpError {
        McpError::internal_error(format!("db lock poisoned: {e}"), None)
    }

    #[tool(
        description = "Full-text search over OCR'd screenshot history. Optional time/app filters."
    )]
    async fn search_screenshots(
        &self,
        Parameters(input): Parameters<SearchScreenshotsInput>,
    ) -> Result<CallToolResult, McpError> {
        let db = self.db.lock().map_err(Self::lock_err)?;
        let out = search_screenshots(&db, input)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Self::ok_json(&out)
    }

    #[tool(description = "Chronological activity between start_time and end_time.")]
    async fn get_timeline(
        &self,
        Parameters(input): Parameters<GetTimelineInput>,
    ) -> Result<CallToolResult, McpError> {
        let db = self.db.lock().map_err(Self::lock_err)?;
        let out = get_timeline(&db, input)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Self::ok_json(&out)
    }

    #[tool(description = "App usage breakdown (minutes per app) over a time range.")]
    async fn get_app_usage(
        &self,
        Parameters(input): Parameters<GetAppUsageInput>,
    ) -> Result<CallToolResult, McpError> {
        let db = self.db.lock().map_err(Self::lock_err)?;
        let out = get_app_usage(&db, input, self.capture_interval_seconds)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Self::ok_json(&out)
    }

    #[tool(description = "Full OCR text and metadata for one screenshot.")]
    async fn get_screenshot_detail(
        &self,
        Parameters(input): Parameters<GetScreenshotDetailInput>,
    ) -> Result<CallToolResult, McpError> {
        let db = self.db.lock().map_err(Self::lock_err)?;
        let out = get_screenshot_detail(&db, input)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Self::ok_json(&out)
    }

    #[tool(description = "Timeline for the last N minutes (default 30).")]
    async fn get_recent_activity(
        &self,
        Parameters(input): Parameters<GetRecentActivityInput>,
    ) -> Result<CallToolResult, McpError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let db = self.db.lock().map_err(Self::lock_err)?;
        let out = get_recent_activity(&db, input, now)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Self::ok_json(&out)
    }
}

#[tool_handler]
impl ServerHandler for RewindosMcpServer {}

pub async fn run(config: AppConfig) -> anyhow::Result<()> {
    let db_path = config.db_path()?;
    let db = Database::open(&db_path)?;
    let server = RewindosMcpServer::new(db, config.capture.interval_seconds);
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
