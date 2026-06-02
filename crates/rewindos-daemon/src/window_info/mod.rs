pub mod gnome_shell;
pub mod kwin;
pub mod noop;
pub mod window_calls_ext;
pub mod wlr_foreign_toplevel;

use async_trait::async_trait;
use tracing::debug;

/// A hot-swappable handle to the active window info provider. The capture loop
/// reads the current provider each tick; a D-Bus recheck can swap it in place.
///
/// The inner `Arc<Box<dyn WindowInfoProvider>>` is used (rather than
/// `Arc<dyn WindowInfoProvider>`) because `arc_swap::ArcSwapAny` requires its
/// type parameter to implement `RefCnt`, which in turn requires `T: Sized` (the
/// base type of `AtomicPtr<T::Base>` must be `Sized`). `Box<dyn Trait>` is
/// `Sized`, so `Arc<Box<dyn WindowInfoProvider>>` satisfies the bound.
pub type SharedProvider =
    std::sync::Arc<arc_swap::ArcSwapAny<std::sync::Arc<Box<dyn WindowInfoProvider>>>>;

/// Thin wrapper so that an `Arc<dyn WindowInfoProvider>` can be placed inside
/// a `Box<dyn WindowInfoProvider>` (which is `Sized`) for use with `arc_swap`.
struct ArcProviderWrapper(std::sync::Arc<dyn WindowInfoProvider>);

#[async_trait::async_trait]
impl WindowInfoProvider for ArcProviderWrapper {
    fn name(&self) -> &'static str {
        self.0.name()
    }
    async fn probe(&self) -> bool {
        self.0.probe().await
    }
    async fn start(&self) -> Result<(), WindowInfoError> {
        self.0.start().await
    }
    fn current(&self) -> WindowInfo {
        self.0.current()
    }
    async fn stop(&self) -> Result<(), WindowInfoError> {
        self.0.stop().await
    }
}

/// Convert an `Arc<dyn WindowInfoProvider>` into the inner
/// `Arc<Box<dyn WindowInfoProvider>>` suitable for use with
/// `ArcSwapAny::store`.
///
/// `arc_swap` cannot store `Arc<dyn Trait>` directly (the `dyn Trait` base
/// would become the target of an `AtomicPtr`, but `AtomicPtr<T>` requires
/// `T: Sized`). This function wraps the pointer in a thin delegating struct so
/// the resulting `Box<dyn WindowInfoProvider>` is `Sized`.
pub fn into_shared_inner(
    provider: std::sync::Arc<dyn WindowInfoProvider>,
) -> std::sync::Arc<Box<dyn WindowInfoProvider>> {
    let boxed: Box<dyn WindowInfoProvider> = Box::new(ArcProviderWrapper(provider));
    std::sync::Arc::new(boxed)
}

/// Convert an `Arc<dyn WindowInfoProvider>` into a `SharedProvider`.
pub fn into_shared(
    provider: std::sync::Arc<dyn WindowInfoProvider>,
) -> SharedProvider {
    std::sync::Arc::new(arc_swap::ArcSwapAny::new(into_shared_inner(provider)))
}

/// Metadata about the currently active window.
#[derive(Debug, Clone, Default)]
pub struct WindowInfo {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_class: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum WindowInfoError {
    #[error("D-Bus error: {0}")]
    #[allow(dead_code)]
    DBus(String),

    #[error("provider error: {0}")]
    Provider(String),
}

/// Trait for active window information providers.
#[async_trait]
pub trait WindowInfoProvider: Send + Sync + 'static {
    /// Human-readable name for logging.
    #[allow(dead_code)]
    fn name(&self) -> &'static str;

    /// Check if this provider is available on the current system.
    #[allow(dead_code)]
    async fn probe(&self) -> bool;

    /// Start tracking the active window.
    async fn start(&self) -> Result<(), WindowInfoError>;

    /// Read the current active window info (non-blocking, from cache).
    fn current(&self) -> WindowInfo;

    /// Stop tracking and clean up resources.
    async fn stop(&self) -> Result<(), WindowInfoError>;
}

/// Check if the active window should be excluded from capture.
///
/// Matches against `excluded_apps` (by app_name or window_class)
/// and `excluded_title_patterns` (substring match on window_title).
pub fn is_excluded(
    info: &WindowInfo,
    excluded_apps: &[String],
    excluded_title_patterns: &[String],
) -> bool {
    for excluded in excluded_apps {
        let excluded_lower = excluded.to_lowercase();

        if let Some(ref app) = info.app_name {
            let app_lower = app.to_lowercase();
            if app_lower == excluded_lower || app_lower.contains(&excluded_lower) {
                debug!(app = %app, "excluding by app_name");
                return true;
            }
        }

        if let Some(ref class) = info.window_class {
            let class_lower = class.to_lowercase();
            if class_lower == excluded_lower || class_lower.contains(&excluded_lower) {
                debug!(class = %class, "excluding by window_class");
                return true;
            }
        }
    }

    if let Some(ref title) = info.window_title {
        let title_lower = title.to_lowercase();
        for pattern in excluded_title_patterns {
            if title_lower.contains(&pattern.to_lowercase()) {
                debug!(title = %title, pattern = %pattern, "excluding by title pattern");
                return true;
            }
        }
    }

    false
}

pub fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_info(app: &str, title: &str, class: &str) -> WindowInfo {
        WindowInfo {
            app_name: non_empty(app.to_string()),
            window_title: non_empty(title.to_string()),
            window_class: non_empty(class.to_string()),
        }
    }

    #[test]
    fn is_excluded_should_match_app_name() {
        let info = make_info("keepassxc", "KeePassXC - Passwords", "keepassxc");
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_be_case_insensitive() {
        let info = make_info("KeePassXC", "Passwords", "KeePassXC");
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_match_window_class() {
        let info = make_info("firefox", "Some Page", "bitwarden");
        let excluded_apps = vec!["bitwarden".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_match_title_pattern() {
        let info = make_info("firefox", "Gmail - Private Browsing", "Navigator");
        let patterns = vec!["Private Browsing".to_string()];

        assert!(is_excluded(&info, &[], &patterns));
    }

    #[test]
    fn is_excluded_should_match_title_pattern_case_insensitive() {
        let info = make_info("firefox", "Some Page - INCOGNITO", "Navigator");
        let patterns = vec!["incognito".to_string()];

        assert!(is_excluded(&info, &[], &patterns));
    }

    #[test]
    fn is_excluded_should_allow_non_excluded_apps() {
        let info = make_info("firefox", "GitHub - Pull Request", "Navigator");
        let excluded_apps = vec!["keepassxc".to_string(), "bitwarden".to_string()];
        let patterns = vec!["Private Browsing".to_string()];

        assert!(!is_excluded(&info, &excluded_apps, &patterns));
    }

    #[test]
    fn is_excluded_should_match_substring_app_id() {
        // Tauri apps report identifier like "com.jay.rewindos" while
        // excluded_apps may contain just "rewindos"
        let info = make_info("com.jay.rewindos", "RewindOS", "com.jay.rewindos");
        let excluded_apps = vec!["rewindos".to_string()];

        assert!(is_excluded(&info, &excluded_apps, &[]));
    }

    #[test]
    fn is_excluded_should_handle_empty_window_info() {
        let info = WindowInfo::default();
        let excluded_apps = vec!["keepassxc".to_string()];

        assert!(!is_excluded(&info, &excluded_apps, &[]));
    }
}
