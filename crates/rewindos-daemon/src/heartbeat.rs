//! Anonymous daily usage heartbeat.
//!
//! While the daemon runs with capture enabled, it pings the update service's
//! `/beat` endpoint on a timer so the project can count distinct *active*
//! devices (rather than "the UI window was open"). The worker hashes the
//! caller IP with a daily, server-only salt and stores only a per-day count —
//! no IP or identifier is retained (see `workers/update-proxy` and the public
//! transparency page). Opt out with `[privacy] usage_heartbeat = false`.

use std::time::Duration;

use rewindos_core::config::AppConfig;
use rewindos_core::usage;
use tracing::debug;

/// Matches the UI update-check cadence; same-device beats dedupe per day.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// Let the daemon settle before the first beat.
const STARTUP_DELAY: Duration = Duration::from_secs(30);

/// Spawn the heartbeat loop. Sends a beat shortly after startup, then every 6h,
/// re-reading config each tick so the opt-out takes effect without a restart.
pub fn spawn() {
    let client = match reqwest::Client::builder()
        .user_agent("rewindos-daemon")
        .default_headers(usage::headers())
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            debug!(error = %e, "heartbeat: client build failed; disabled");
            return;
        }
    };
    let beat_url = format!("{}/beat", usage::PROXY_BASE);

    tokio::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            // Fresh config each tick: the UI edits config.toml without telling us.
            let enabled = AppConfig::load()
                .map(|c| c.privacy.usage_heartbeat && c.capture.enabled)
                .unwrap_or(false);
            if !enabled {
                continue;
            }
            match client.get(&beat_url).send().await {
                Ok(_) => debug!("heartbeat: sent"),
                Err(e) => debug!(error = %e, "heartbeat: send failed (ignored)"),
            }
        }
    });
}
