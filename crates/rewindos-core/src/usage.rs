//! Shared bits for the update-service check-in — used by the desktop updater
//! (update check) and the daemon (heartbeat). See `workers/update-proxy`.

use reqwest::header::{HeaderMap, HeaderValue};

/// Base URL of the update proxy. The updater appends
/// `/repos/.../releases/latest`; the daemon hits `/beat`.
pub const PROXY_BASE: &str = "https://rewindos-updates.incident-agent.workers.dev";

/// Headers the proxy aggregates into anonymous per-(day, version, platform)
/// counts: the app version ([`crate::VERSION`], from tauri.conf.json via
/// build.rs) and desktop environment. Harmless on the GitHub fallback, which
/// ignores unknown headers.
pub fn headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(crate::VERSION) {
        headers.insert("X-RewindOS-Version", v);
    }
    if let Some(p) = std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .and_then(|s| HeaderValue::from_str(&s).ok())
    {
        headers.insert("X-RewindOS-Platform", p);
    }
    headers
}
