use std::path::Path;

use rewindos_core::analytics::{install_id, ChatProvider, CommonProps, Endpoint, Source};
use rewindos_core::config::AppConfig;
use rewindos_core::schema::SearchMode;
use serde::Serialize;
use tauri::Emitter;

#[derive(Serialize)]
pub struct Bootstrap {
    enabled: bool,
    project: Option<Project>,
}

#[derive(Serialize)]
struct Project {
    endpoint: Endpoint,
    distinct_id: String,
    common: CommonProps,
}

pub fn bootstrap(dir: &Path, endpoint: Option<Endpoint>) -> Result<Bootstrap, String> {
    let enabled = AppConfig::load_from(&dir.join("config.toml"))
        .is_ok_and(|config| config.privacy.analytics);
    let project = if enabled {
        endpoint.map(|endpoint| {
            Ok::<_, String>(Project {
                endpoint,
                distinct_id: install_id(dir).map_err(|e| e.to_string())?.to_string(),
                common: CommonProps::detect(Source::Ui),
            })
        }).transpose()?
    } else {
        None
    };
    Ok(Bootstrap { enabled, project })
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum NativeEvent {
    SearchPerformed { mode: SearchMode, has_filters: bool },
    AskSent { provider: ChatProvider },
}

pub fn emit(app: &tauri::AppHandle, event: NativeEvent) {
    let enabled = AppConfig::default_base_dir()
        .and_then(|dir| AppConfig::load_from(&dir.join("config.toml")))
        .is_ok_and(|config| config.privacy.analytics);
    if enabled {
        let _ = app.emit("analytics-action", event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bootstrap_reuses_the_daemon_identity_and_exposes_only_public_config() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.toml"), "[privacy]\nanalytics = true\n").unwrap();
        let daemon_id = install_id(dir.path()).unwrap();
        let value = serde_json::to_value(bootstrap(dir.path(), Some(Endpoint::new("https://us.i.posthog.com", "public"))).unwrap()).unwrap();
        assert_eq!(value["project"]["distinct_id"], daemon_id.to_string());
        assert_eq!(value["project"]["endpoint"], json!({"host": "https://us.i.posthog.com", "api_key": "public"}));
        assert_eq!(value["project"]["common"]["source"], "ui");
        assert_eq!(value["project"].as_object().unwrap().len(), 3);
    }

    #[test]
    fn no_key_opt_out_and_unreadable_config_never_create_an_identity() {
        for (config, endpoint) in [
            (Some(true), None),
            (Some(false), Some(Endpoint::new("http://localhost", "k"))),
            (None, Some(Endpoint::new("http://localhost", "k"))),
        ] {
            let dir = tempfile::tempdir().unwrap();
            if let Some(enabled) = config {
                std::fs::write(dir.path().join("config.toml"), format!("[privacy]\nanalytics = {enabled}\n")).unwrap();
            }
            assert!(bootstrap(dir.path(), endpoint).unwrap().project.is_none());
            assert!(!dir.path().join("install_id").exists());
        }
    }

    #[test]
    fn bridge_has_exact_content_free_properties() {
        assert_eq!(serde_json::to_value(NativeEvent::SearchPerformed { mode: SearchMode::Hybrid, has_filters: true }).unwrap(), json!({"event": "search_performed", "mode": "hybrid", "has_filters": true}));
        assert_eq!(serde_json::to_value(NativeEvent::AskSent { provider: ChatProvider::ClaudeCode }).unwrap(), json!({"event": "ask_sent", "provider": "claude_code"}));
    }
}
