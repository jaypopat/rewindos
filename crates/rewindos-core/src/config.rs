use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub capture: CaptureConfig,
    pub storage: StorageConfig,
    pub privacy: PrivacyConfig,
    pub ocr: OcrConfig,
    pub ui: UiConfig,
    pub semantic: SemanticConfig,
    pub chat: ChatConfig,
    pub focus: FocusConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureConfig {
    pub interval_seconds: u32,
    pub change_threshold: u32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StorageConfig {
    pub base_dir: String,
    pub retention_days: u32,
    pub screenshot_quality: u8,
    pub thumbnail_width: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PrivacyConfig {
    pub excluded_apps: Vec<String>,
    pub excluded_title_patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OcrConfig {
    pub enabled: bool,
    pub tesseract_lang: String,
    pub max_workers: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    pub global_hotkey: String,
    pub theme: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SemanticConfig {
    pub enabled: bool,
    pub ollama_url: String,
    pub model: String,
    pub embedding_dimensions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatConfig {
    pub enabled: bool,
    pub ollama_url: String,
    pub model: String,
    pub max_context_tokens: usize,
    pub max_history_messages: usize,
    pub temperature: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FocusConfig {
    pub work_minutes: u32,
    pub short_break_minutes: u32,
    pub long_break_minutes: u32,
    pub sessions_before_long_break: u32,
    pub daily_goal_minutes: u32,
    pub distraction_apps: Vec<String>,
    pub auto_start_breaks: bool,
    pub auto_start_work: bool,
    /// User-defined category rules: category name → list of app name keywords.
    /// Merged with built-in defaults on the frontend. Add entries here to
    /// override or extend the default categories.
    pub category_rules: HashMap<String, Vec<String>>,
}

impl Default for FocusConfig {
    fn default() -> Self {
        Self {
            work_minutes: 25,
            short_break_minutes: 5,
            long_break_minutes: 15,
            sessions_before_long_break: 4,
            daily_goal_minutes: 480,
            distraction_apps: vec![
                "discord".to_string(),
                "slack".to_string(),
                "twitter".to_string(),
                "reddit".to_string(),
            ],
            auto_start_breaks: true,
            auto_start_work: false,
            category_rules: HashMap::new(),
        }
    }
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ollama_url: "http://localhost:11434".to_string(),
            model: "qwen2.5:3b".to_string(),
            max_context_tokens: 4096,
            max_history_messages: 20,
            temperature: 0.3,
        }
    }
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 5,
            change_threshold: 3,
            enabled: true,
        }
    }
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            base_dir: "~/.rewindos".to_string(),
            retention_days: 90,
            screenshot_quality: 80,
            thumbnail_width: 320,
        }
    }
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            excluded_apps: vec![
                "rewindos".to_string(),
                "keepassxc".to_string(),
                "1password".to_string(),
                "bitwarden".to_string(),
                "gnome-keyring".to_string(),
            ],
            excluded_title_patterns: vec![
                "Private Browsing".to_string(),
                "Incognito".to_string(),
                "Lock Screen".to_string(),
                "Screen Locker".to_string(),
            ],
        }
    }
}

impl Default for OcrConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tesseract_lang: "eng".to_string(),
            max_workers: 2,
        }
    }
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            global_hotkey: "Ctrl+Shift+Space".to_string(),
            theme: "system".to_string(),
        }
    }
}

impl Default for SemanticConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            ollama_url: "http://localhost:11434".to_string(),
            model: "nomic-embed-text".to_string(),
            embedding_dimensions: 768,
        }
    }
}

impl AppConfig {
    /// Load config from `~/.rewindos/config.toml`, creating defaults if missing.
    pub fn load() -> Result<Self> {
        let base_dir = Self::default_base_dir()?;
        let config_path = base_dir.join("config.toml");

        if config_path.exists() {
            let contents = fs::read_to_string(&config_path)
                .map_err(|e| CoreError::Config(format!("failed to read config: {e}")))?;
            let config: AppConfig = toml::from_str(&contents)
                .map_err(|e| CoreError::Config(format!("failed to parse config: {e}")))?;
            Ok(config)
        } else {
            let config = AppConfig::default();
            config.ensure_dirs()?;
            let toml_str = toml::to_string_pretty(&config)
                .map_err(|e| CoreError::Config(format!("failed to serialize config: {e}")))?;
            fs::write(&config_path, toml_str)?;
            Ok(config)
        }
    }

    /// Load config from a specific path (for testing or custom setups).
    pub fn load_from(path: &Path) -> Result<Self> {
        let contents = fs::read_to_string(path)
            .map_err(|e| CoreError::Config(format!("failed to read config: {e}")))?;
        let config: AppConfig = toml::from_str(&contents)
            .map_err(|e| CoreError::Config(format!("failed to parse config: {e}")))?;
        Ok(config)
    }

    /// Returns the resolved base directory (expands `~`).
    pub fn base_dir(&self) -> Result<PathBuf> {
        resolve_tilde(&self.storage.base_dir)
    }

    /// Returns the default base directory (`~/.rewindos`).
    pub fn default_base_dir() -> Result<PathBuf> {
        let home = dirs::home_dir()
            .ok_or_else(|| CoreError::Config("could not determine home directory".to_string()))?;
        Ok(home.join(".rewindos"))
    }

    /// Returns the path to the SQLite database.
    pub fn db_path(&self) -> Result<PathBuf> {
        Ok(self.base_dir()?.join("rewindos.db"))
    }

    /// Returns the path to the screenshots directory.
    pub fn screenshots_dir(&self) -> Result<PathBuf> {
        Ok(self.base_dir()?.join("screenshots"))
    }

    /// Returns the path to the logs directory.
    pub fn logs_dir(&self) -> Result<PathBuf> {
        Ok(self.base_dir()?.join("logs"))
    }

    /// Ensure all required directories exist.
    pub fn ensure_dirs(&self) -> Result<()> {
        let base = self.base_dir()?;
        fs::create_dir_all(&base)?;
        fs::create_dir_all(base.join("screenshots"))?;
        fs::create_dir_all(base.join("logs"))?;
        Ok(())
    }
}

/// Expand `~` to the user's home directory.
fn resolve_tilde(path: &str) -> Result<PathBuf> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = dirs::home_dir()
            .ok_or_else(|| CoreError::Config("could not determine home directory".to_string()))?;
        Ok(home.join(rest))
    } else if path == "~" {
        dirs::home_dir()
            .ok_or_else(|| CoreError::Config("could not determine home directory".to_string()))
    } else {
        Ok(PathBuf::from(path))
    }
}

/// Initialize tracing/logging with env filter.
///
/// Respects `RUST_LOG` env var. Defaults to `info` level.
pub fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.capture.interval_seconds, 5);
        assert_eq!(config.capture.change_threshold, 3);
        assert!(config.capture.enabled);
        assert_eq!(config.storage.retention_days, 90);
        assert_eq!(config.storage.screenshot_quality, 80);
        assert_eq!(config.ocr.tesseract_lang, "eng");
    }

    #[test]
    fn test_load_from_toml() {
        let toml_content = r#"
[capture]
interval_seconds = 10
change_threshold = 5
enabled = false

[storage]
base_dir = "/tmp/test-rewindos"
retention_days = 30

[ocr]
tesseract_lang = "deu"
"#;
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(toml_content.as_bytes()).unwrap();

        let config = AppConfig::load_from(f.path()).unwrap();
        assert_eq!(config.capture.interval_seconds, 10);
        assert_eq!(config.capture.change_threshold, 5);
        assert!(!config.capture.enabled);
        assert_eq!(config.storage.retention_days, 30);
        assert_eq!(config.ocr.tesseract_lang, "deu");
        // defaults for fields not specified
        assert_eq!(config.storage.screenshot_quality, 80);
        assert_eq!(config.ui.theme, "system");
    }
}
