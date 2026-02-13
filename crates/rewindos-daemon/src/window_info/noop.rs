use async_trait::async_trait;
use tracing::info;

use super::{WindowInfo, WindowInfoError, WindowInfoProvider};

/// Fallback provider that always returns empty window info.
/// Used when no compositor-specific provider is available.
pub struct NoopWindowInfo;

#[async_trait]
impl WindowInfoProvider for NoopWindowInfo {
    fn name(&self) -> &'static str {
        "Noop"
    }

    async fn probe(&self) -> bool {
        true
    }

    async fn start(&self) -> Result<(), WindowInfoError> {
        info!("no window info provider available — window metadata will be empty");
        Ok(())
    }

    fn current(&self) -> WindowInfo {
        WindowInfo::default()
    }

    async fn stop(&self) -> Result<(), WindowInfoError> {
        Ok(())
    }
}
