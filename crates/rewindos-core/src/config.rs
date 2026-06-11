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
    pub meeting: MeetingConfig,
    pub vault_export: VaultExportConfig,
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
    pub max_capture_width: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PrivacyConfig {
    pub excluded_apps: Vec<String>,
    pub excluded_title_patterns: Vec<String>,
    /// Opt-in escape hatch: capture even when window metadata can't enforce the
    /// exclusion lists (the privacy gate would otherwise pause capture). Default
    /// false (fail-closed). In-memory at runtime via D-Bus `SetUnfilteredCapture`;
    /// set here to make the risk-acceptance durable across restarts.
    #[serde(default)]
    pub capture_without_exclusion_enforcement: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OcrConfig {
    pub enabled: bool,
    /// OCR engine to use: "tesseract" or "paddleocr"
    pub engine: String,
    pub tesseract_lang: String,
    pub max_workers: u32,
    /// Directory for PaddleOCR ONNX models (legacy, unused by sidecar)
    pub model_dir: String,
    /// Python binary to use for PaddleOCR sidecar (default: "python3")
    pub python_bin: String,
    /// Kill PaddleOCR worker after this many seconds of inactivity (default: 60)
    pub idle_timeout_secs: u64,
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
    /// UI hint only: "ollama" | "lmstudio" | "openai" | "openrouter" | "custom".
    pub provider: String,
    /// OpenAI-style API base, e.g. "http://localhost:11434/v1".
    pub base_url: String,
    /// Bearer token; empty = no Authorization header.
    pub api_key: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MeetingConfig {
    pub enabled: bool,
    pub engine: String,
    pub model: String,
    pub model_dir: String,
    /// Path or PATH name of the whisper.cpp binary.
    pub whisper_bin: String,
    pub keep_audio: bool,
    pub summary_enabled: bool,
    /// Global hotkey to toggle meeting recording (separate from `UiConfig::global_hotkey`).
    pub hotkey: String,
    /// Capture/transcribe sample rate (whisper expects 16 kHz mono).
    pub sample_rate: u32,
    /// PipeWire `node.name` of the mic to capture. Empty = system default.
    #[serde(default)]
    pub mic_source: String,
    /// Capture the mic through a PipeWire echo-cancelled source during
    /// meetings, so remote audio playing on the speakers doesn't bleed into
    /// the "You" track. Falls back to the raw mic if setup fails.
    pub echo_cancel: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultExportConfig {
    /// Master switch. Stays false until vault_path is set and writable.
    pub enabled: bool,
    /// "obsidian" | "logseq"
    pub format: String,
    /// Absolute path to the vault (Obsidian) / graph (Logseq) root.
    pub vault_path: String,
    /// Obsidian: companion subdir; Logseq: companion page namespace.
    pub companion_dir: String,
    /// Which sections to emit: journal | summary | meetings | moments | stats
    pub sections: Vec<String>,
    pub max_moments: u32,
    /// Copy thumbnails into the vault (durable). false = links only (fragile).
    pub copy_thumbnails: bool,
    /// Local hour (0-23) the daemon finalizes the completed day.
    pub end_of_day_hour: u32,
    /// Opt-in: create the user's daily note with the embed if it doesn't exist.
    /// Creates only; never overwrites an existing note.
    pub create_daily_note_if_absent: bool,
}

impl Default for MeetingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: "whisper-cpp".to_string(),
            model: "base.en".to_string(),
            model_dir: "~/.rewindos/models/whisper".to_string(),
            whisper_bin: "whisper-cli".to_string(),
            keep_audio: true,
            summary_enabled: true,
            hotkey: "Ctrl+Shift+M".to_string(),
            sample_rate: 16000,
            mic_source: String::new(),
            echo_cancel: true,
        }
    }
}

impl Default for ChatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: "ollama".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            api_key: String::new(),
            model: "qwen2.5:7b".to_string(),
            max_context_tokens: 6144,
            max_history_messages: 20,
            temperature: 0.5,
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
            max_capture_width: 1920,
        }
    }
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            excluded_apps: vec![
                // "rewindos" is a substring of every form the providers report
                // (bare app_id, the bundle identifier, "RewindOS"), so one entry
                // self-excludes regardless of desktop/identifier.
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
            capture_without_exclusion_enforcement: false,
        }
    }
}

impl Default for OcrConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            engine: "tesseract".to_string(),
            tesseract_lang: "eng".to_string(),
            max_workers: 2,
            model_dir: "~/.rewindos/models/paddleocr".to_string(),
            python_bin: "python3".to_string(),
            idle_timeout_secs: 60,
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

impl Default for VaultExportConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            format: "obsidian".to_string(),
            vault_path: String::new(),
            companion_dir: "_rewindos".to_string(),
            sections: vec![
                "journal".to_string(),
                "summary".to_string(),
                "meetings".to_string(),
                "moments".to_string(),
                "stats".to_string(),
            ],
            max_moments: 6,
            copy_thumbnails: true,
            end_of_day_hour: 23,
            create_daily_note_if_absent: false,
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
            write_config_file(&config_path, &toml_str)?;
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

    /// Returns the path to the meetings directory (`<base>/meetings`).
    pub fn meetings_dir(&self) -> Result<PathBuf> {
        Ok(self.base_dir()?.join("meetings"))
    }

    /// Returns the resolved whisper model directory (expands `~`).
    pub fn whisper_model_dir(&self) -> Result<PathBuf> {
        resolve_tilde(&self.meeting.model_dir)
    }

    /// Resolved path to the whisper GGUF model file
    /// (`<model_dir>/ggml-<model>.bin`, the whisper.cpp naming convention).
    pub fn whisper_model_path(&self) -> Result<PathBuf> {
        Ok(self
            .whisper_model_dir()?
            .join(format!("ggml-{}.bin", self.meeting.model)))
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
        fs::create_dir_all(base.join("meetings"))?;
        fs::create_dir_all(base.join("logs"))?;
        Ok(())
    }
}

/// Expand `~` to the user's home directory (public version for other modules).
pub fn resolve_tilde_pub(path: &str) -> Result<PathBuf> {
    resolve_tilde(path)
}

/// Write a config TOML file with owner-only (0600) permissions — the chat
/// section may contain an API key. Creates with 0600 from the start and
/// re-tightens pre-existing files.
pub fn write_config_file(path: &Path, toml_str: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(toml_str.as_bytes())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
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
    fn privacy_override_defaults_to_false() {
        let p = PrivacyConfig::default();
        assert!(!p.capture_without_exclusion_enforcement);
    }

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
    fn meeting_config_defaults() {
        let c = AppConfig::default();
        assert!(!c.meeting.enabled);
        assert_eq!(c.meeting.engine, "whisper-cpp");
        assert_eq!(c.meeting.model, "base.en");
        assert_eq!(c.meeting.whisper_bin, "whisper-cli");
        assert!(c.meeting.keep_audio);
        assert!(c.meeting.summary_enabled);
        assert_eq!(c.meeting.hotkey, "Ctrl+Shift+M");
        assert_eq!(c.meeting.sample_rate, 16000);
    }

    #[test]
    fn meeting_dirs_resolve() {
        let mut c = AppConfig::default();
        c.storage.base_dir = "/tmp/rwos-test".to_string();
        c.meeting.model_dir = "/tmp/rwos-test/models/whisper".to_string();
        assert_eq!(c.meetings_dir().unwrap(), std::path::PathBuf::from("/tmp/rwos-test/meetings"));
        assert_eq!(c.whisper_model_dir().unwrap(), std::path::PathBuf::from("/tmp/rwos-test/models/whisper"));
    }

    #[test]
    fn whisper_model_path_uses_ggml_prefix() {
        let mut c = AppConfig::default();
        c.meeting.model_dir = "/tmp/rwos-test/models/whisper".to_string();
        c.meeting.model = "base.en".to_string();
        assert_eq!(
            c.whisper_model_path().unwrap(),
            std::path::PathBuf::from("/tmp/rwos-test/models/whisper/ggml-base.en.bin")
        );
    }

    #[test]
    fn vault_export_config_defaults() {
        let c = VaultExportConfig::default();
        assert!(!c.enabled);
        assert!(c.vault_path.is_empty());
        assert_eq!(c.format, "obsidian");
        assert_eq!(c.companion_dir, "_rewindos");
        assert_eq!(c.max_moments, 6);
        assert!(c.copy_thumbnails);
        assert_eq!(c.end_of_day_hour, 23);
        assert!(!c.create_daily_note_if_absent);
        assert_eq!(c.sections, vec!["journal", "summary", "meetings", "moments", "stats"]);
    }

    #[test]
    fn app_config_has_vault_export_default() {
        let c = AppConfig::default();
        assert!(!c.vault_export.enabled);
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

    #[test]
    fn chat_config_defaults_to_ollama_preset() {
        let c = ChatConfig::default();
        assert_eq!(c.provider, "ollama");
        assert_eq!(c.base_url, "http://localhost:11434/v1");
        assert!(c.api_key.is_empty());
    }

    #[test]
    fn chat_config_ignores_removed_ollama_url_key() {
        // Old configs containing the removed `ollama_url` key must still parse,
        // falling back to the new defaults.
        let toml_content = r#"
[chat]
ollama_url = "http://somewhere-else:11434"
model = "llama3"
"#;
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(toml_content.as_bytes()).unwrap();

        let config = AppConfig::load_from(f.path()).unwrap();
        assert_eq!(config.chat.model, "llama3");
        assert_eq!(config.chat.base_url, "http://localhost:11434/v1");
    }

    #[test]
    fn config_file_written_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        write_config_file(&path, "x = 1\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn write_config_file_repairs_existing_world_readable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "old = 1\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_config_file(&path, "new = 2\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(fs::read_to_string(&path).unwrap(), "new = 2\n");
    }
}
