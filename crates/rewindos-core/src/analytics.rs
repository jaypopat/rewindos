//! Usage analytics sent to PostHog's `/batch/` endpoint. `docs/analytics.md`
//! lists every event and property, and a test below keeps the two in sync.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tracing::debug;
use uuid::Uuid;

use crate::config::{AppConfig, ChatConfig};
use crate::ocr::OcrEngine;
use crate::schema::SearchMode;

const DEFAULT_HOST: &str = "https://us.i.posthog.com";

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    AppOpened,
    ViewOpened { view: View },
    SearchPerformed { mode: SearchMode, has_filters: bool },
    AskSent { provider: ChatProvider },
    PrivateModeToggled { enabled: bool },
    DaemonHeartbeat(Heartbeat),
}

/// Mirrors the `View` union in `src/components/Sidebar.tsx`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Dashboard,
    History,
    Rewind,
    Search,
    Saved,
    Journal,
    Ask,
    Meetings,
    Settings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatProvider {
    Ollama,
    Lmstudio,
    Openai,
    Openrouter,
    ClaudeCode,
    Custom,
}

impl ChatProvider {
    /// Maps the Settings → AI preset id. Claude Code is an Ask route, never a
    /// config value.
    pub fn from_config(chat: &ChatConfig) -> Self {
        match chat.provider.as_str() {
            "ollama" => Self::Ollama,
            "lmstudio" => Self::Lmstudio,
            "openai" => Self::Openai,
            "openrouter" => Self::Openrouter,
            _ => Self::Custom,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Heartbeat {
    pub capture_enabled: bool,
    pub semantic_enabled: bool,
    pub chat_enabled: bool,
    pub chat_provider: ChatProvider,
    pub agentic_tools: bool,
    pub meeting_enabled: bool,
    pub vault_export_enabled: bool,
    pub ocr_engine: OcrEngine,
    pub capture_interval_s: u32,
    pub private_mode: bool,
    pub screenshots_today_bucket: CountBucket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CountBucket {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1-99")]
    Under100,
    #[serde(rename = "100-999")]
    Under1000,
    #[serde(rename = "1000+")]
    Thousands,
}

impl CountBucket {
    pub fn of(count: i64) -> Self {
        match count {
            ..=0 => Self::Zero,
            1..=99 => Self::Under100,
            100..=999 => Self::Under1000,
            _ => Self::Thousands,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Daemon,
    Ui,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Desktop {
    Kde,
    Gnome,
    Hyprland,
    Sway,
    Cosmic,
    Other,
}

impl Desktop {
    /// `XDG_CURRENT_DESKTOP` is a colon-separated list, e.g. `ubuntu:GNOME`.
    fn from_xdg(value: &str) -> Self {
        value
            .split(':')
            .find_map(|name| match name.to_ascii_lowercase().as_str() {
                "kde" => Some(Self::Kde),
                "gnome" => Some(Self::Gnome),
                "hyprland" => Some(Self::Hyprland),
                "sway" => Some(Self::Sway),
                "cosmic" => Some(Self::Cosmic),
                _ => None,
            })
            .unwrap_or(Self::Other)
    }
}

#[derive(Debug, Serialize)]
struct CommonProps {
    app_version: &'static str,
    desktop: Desktop,
    distro: String,
    source: Source,
    #[serde(rename = "$geoip_disable")]
    geoip_disable: bool,
}

impl CommonProps {
    fn detect(source: Source) -> Self {
        Self {
            app_version: crate::VERSION,
            desktop: Desktop::from_xdg(&std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default()),
            distro: distro_id(&fs::read_to_string("/etc/os-release").unwrap_or_default()),
            source,
            geoip_disable: true,
        }
    }
}

fn distro_id(os_release: &str) -> String {
    os_release
        .lines()
        .find_map(|line| line.strip_prefix("ID="))
        .map(|id| id.trim().trim_matches(['"', '\'']).to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// An event and the moment it happened. The app sends in batches, so the send
/// time is not the event time.
#[derive(Debug)]
pub struct Stamped {
    event: Event,
    at: DateTime<Utc>,
}

impl Stamped {
    pub fn now(event: Event) -> Self {
        Self { event, at: Utc::now() }
    }
}

#[derive(Debug, Clone)]
pub struct Endpoint {
    host: String,
    api_key: String,
}

impl Endpoint {
    pub fn new(host: &str, api_key: &str) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        }
    }

    /// The PostHog project baked in at build time. `None` without a key, so
    /// builds from source send nothing.
    pub fn compiled() -> Option<Self> {
        Self::from_build_env(
            option_env!("REWINDOS_POSTHOG_KEY"),
            option_env!("REWINDOS_POSTHOG_HOST"),
        )
    }

    /// CI passes an unset repository variable as an empty string.
    fn from_build_env(key: Option<&str>, host: Option<&str>) -> Option<Self> {
        fn set(value: Option<&str>) -> Option<&str> {
            value.map(str::trim).filter(|v| !v.is_empty())
        }
        Some(Self::new(set(host).unwrap_or(DEFAULT_HOST), set(key)?))
    }
}

pub struct Analytics {
    http: reqwest::Client,
    endpoint: Option<Endpoint>,
    dir: PathBuf,
    common: CommonProps,
}

impl Analytics {
    /// `dir` holds `config.toml` and `install_id`: [`AppConfig::default_base_dir`]
    /// outside tests.
    pub fn new(source: Source, dir: PathBuf, endpoint: Option<Endpoint>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            endpoint,
            dir,
            common: CommonProps::detect(source),
        }
    }

    /// Sends `events` as one batch, or nothing when no key is compiled in or
    /// `[privacy] analytics` is off. Reads the config from disk on every call,
    /// so a Settings toggle applies without a restart. A failed send is logged
    /// and its events dropped.
    pub async fn send(&self, events: Vec<Stamped>) {
        let Some(endpoint) = &self.endpoint else { return };
        if events.is_empty() || !self.enabled() {
            return;
        }
        let distinct_id = match install_id(&self.dir) {
            Ok(id) => id,
            Err(e) => {
                debug!(error = %e, "analytics: no install id, events dropped");
                return;
            }
        };
        let body = batch_body(&endpoint.api_key, distinct_id, &self.common, &events);
        let sent = self
            .http
            .post(format!("{}/batch/", endpoint.host))
            .json(&body)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status);
        match sent {
            Ok(_) => debug!(count = events.len(), "analytics: sent"),
            Err(e) => debug!(error = %e, "analytics: send failed, events dropped"),
        }
    }

    fn enabled(&self) -> bool {
        AppConfig::load_from(&self.dir.join("config.toml")).is_ok_and(|c| c.privacy.analytics)
    }
}

fn batch_body(api_key: &str, distinct_id: Uuid, common: &CommonProps, events: &[Stamped]) -> Value {
    let common = object(common);
    let batch: Vec<Value> = events
        .iter()
        .map(|stamped| {
            let mut properties = object(&stamped.event);
            let event = properties.remove("event");
            properties.extend(common.clone());
            json!({
                "event": event,
                "distinct_id": distinct_id.to_string(),
                "timestamp": stamped.at,
                "properties": properties,
            })
        })
        .collect();
    json!({ "api_key": api_key, "batch": batch })
}

fn object(value: impl Serialize) -> Map<String, Value> {
    match serde_json::to_value(value) {
        Ok(Value::Object(map)) => map,
        _ => unreachable!("analytics types serialize to JSON objects"),
    }
}

/// The install's PostHog `distinct_id`, created on first use. The daemon and
/// the app can race to create it, so the ID goes to a temp file that is
/// hard-linked into place: the link lands whole or fails with `AlreadyExists`,
/// and the loser reads the winner's ID.
fn install_id(dir: &Path) -> io::Result<Uuid> {
    let path = dir.join("install_id");
    match read_install_id(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        existing => return existing,
    }
    let id = Uuid::new_v4();
    let tmp = dir.join(format!("install_id.{id}.tmp"));
    fs::write(&tmp, id.to_string())?;
    let linked = fs::hard_link(&tmp, &path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(id),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => read_install_id(&path),
        Err(e) => Err(e),
    }
}

fn read_install_id(path: &Path) -> io::Result<Uuid> {
    let text = fs::read_to_string(path)?;
    Uuid::parse_str(text.trim()).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    const FORBIDDEN_KEYS: &[&str] = &[
        "$ip", "ip", "query", "text", "ocr_text", "message", "prompt", "app_name",
        "window_title", "window_class", "file_path", "path", "title", "content",
    ];

    fn manifest_file(relative: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn sample_common() -> CommonProps {
        CommonProps {
            app_version: "1.2.3",
            desktop: Desktop::Kde,
            distro: "arch".to_string(),
            source: Source::Ui,
            geoip_disable: true,
        }
    }

    fn sample_heartbeat() -> Heartbeat {
        Heartbeat {
            capture_enabled: true,
            semantic_enabled: false,
            chat_enabled: true,
            chat_provider: ChatProvider::Lmstudio,
            agentic_tools: false,
            meeting_enabled: false,
            vault_export_enabled: true,
            ocr_engine: OcrEngine::PaddleOcr,
            capture_interval_s: 5,
            private_mode: false,
            screenshots_today_bucket: CountBucket::Under1000,
        }
    }

    fn every_event() -> Vec<Event> {
        let events = vec![
            Event::AppOpened,
            Event::ViewOpened { view: View::Search },
            Event::SearchPerformed { mode: SearchMode::Keyword, has_filters: false },
            Event::AskSent { provider: ChatProvider::ClaudeCode },
            Event::PrivateModeToggled { enabled: true },
            Event::DaemonHeartbeat(sample_heartbeat()),
        ];
        // A new variant fails to compile here until it gets a sample above.
        for event in &events {
            match event {
                Event::AppOpened
                | Event::ViewOpened { .. }
                | Event::SearchPerformed { .. }
                | Event::AskSent { .. }
                | Event::PrivateModeToggled { .. }
                | Event::DaemonHeartbeat(_) => {}
            }
        }
        events
    }

    fn every_view() -> Vec<View> {
        use View::*;
        let views = vec![Dashboard, History, Rewind, Search, Saved, Journal, Ask, Meetings, Settings];
        // A new variant fails to compile here until it is listed above.
        for view in &views {
            match view {
                Dashboard | History | Rewind | Search | Saved | Journal | Ask | Meetings
                | Settings => {}
            }
        }
        views
    }

    fn keys(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    out.push(key.clone());
                    keys(inner, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| keys(item, out)),
            _ => {}
        }
    }

    /// One-request-per-connection HTTP server that forwards each request's
    /// path and JSON body, then answers 200.
    async fn fake_posthog() -> (String, mpsc::UnboundedReceiver<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let (head, body) = loop {
                    let mut chunk = [0u8; 8192];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0, "client closed before sending a full request");
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&buf[..end]).to_string();
                    let length: usize = head
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:")?.trim().parse().ok())
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + length {
                        break (head, buf[end + 4..end + 4 + length].to_vec());
                    }
                };
                let path = head.split_whitespace().nth(1).unwrap_or_default().to_string();
                tx.send((path, serde_json::from_slice(&body).unwrap())).unwrap();
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
                    .await
                    .unwrap();
            }
        });
        (host, rx)
    }

    fn write_config(dir: &Path, analytics: bool) {
        fs::write(dir.join("config.toml"), format!("[privacy]\nanalytics = {analytics}\n")).unwrap();
    }

    #[test]
    fn install_id_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = install_id(dir.path()).unwrap();
        let second = install_id(dir.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.get_version(), Some(uuid::Version::Random));
        assert_eq!(fs::read_to_string(dir.path().join("install_id")).unwrap(), first.to_string());
    }

    #[test]
    fn racing_creators_agree_on_one_install_id() {
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(8);
        let ids: Vec<Uuid> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        install_id(dir.path()).unwrap()
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(ids.iter().all(|id| *id == ids[0]), "ids diverged: {ids:?}");
        let files: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(files, vec!["install_id"], "temp files left behind");
    }

    #[test]
    fn batch_body_matches_the_posthog_batch_shape() {
        let id = Uuid::parse_str("6f1c2a54-93b5-4d0e-9a51-2b7c8e1f0d3a").unwrap();
        let at = Utc.with_ymd_and_hms(2026, 10, 26, 12, 30, 0).unwrap();
        let events = vec![
            Stamped { event: Event::SearchPerformed { mode: SearchMode::Hybrid, has_filters: true }, at },
            Stamped { event: Event::AppOpened, at },
        ];
        let common = json!({
            "app_version": "1.2.3",
            "desktop": "kde",
            "distro": "arch",
            "source": "ui",
            "$geoip_disable": true,
        });
        let with_common = |extra: Value| {
            let mut props = extra.as_object().unwrap().clone();
            props.extend(common.as_object().unwrap().clone());
            Value::Object(props)
        };
        assert_eq!(
            batch_body("phc_test", id, &sample_common(), &events),
            json!({
                "api_key": "phc_test",
                "batch": [
                    {
                        "event": "search_performed",
                        "distinct_id": "6f1c2a54-93b5-4d0e-9a51-2b7c8e1f0d3a",
                        "timestamp": "2026-10-26T12:30:00Z",
                        "properties": with_common(json!({ "mode": "hybrid", "has_filters": true })),
                    },
                    {
                        "event": "app_opened",
                        "distinct_id": "6f1c2a54-93b5-4d0e-9a51-2b7c8e1f0d3a",
                        "timestamp": "2026-10-26T12:30:00Z",
                        "properties": with_common(json!({})),
                    },
                ],
            })
        );
    }

    #[test]
    fn no_event_carries_a_forbidden_field() {
        let events: Vec<Stamped> = every_event().into_iter().map(Stamped::now).collect();
        let mut found = Vec::new();
        keys(&batch_body("k", Uuid::nil(), &sample_common(), &events), &mut found);
        for key in FORBIDDEN_KEYS {
            assert!(!found.iter().any(|k| k == key), "payload carries forbidden key {key}");
        }
    }

    #[test]
    fn heartbeat_serializes_every_property() {
        let props = object(&Event::DaemonHeartbeat(sample_heartbeat()));
        assert_eq!(
            Value::Object(props),
            json!({
                "event": "daemon_heartbeat",
                "capture_enabled": true,
                "semantic_enabled": false,
                "chat_enabled": true,
                "chat_provider": "lmstudio",
                "agentic_tools": false,
                "meeting_enabled": false,
                "vault_export_enabled": true,
                "ocr_engine": "paddleocr",
                "capture_interval_s": 5,
                "private_mode": false,
                "screenshots_today_bucket": "100-999",
            })
        );
    }

    #[test]
    fn docs_list_every_event_and_property() {
        let docs = manifest_file("../../docs/analytics.md");
        let events: Vec<Stamped> = every_event().into_iter().map(Stamped::now).collect();
        let body = batch_body("k", Uuid::nil(), &sample_common(), &events);
        for event in body["batch"].as_array().unwrap() {
            let name = event["event"].as_str().unwrap();
            assert!(docs.contains(&format!("`{name}`")), "docs/analytics.md does not list event `{name}`");
            for property in event["properties"].as_object().unwrap().keys() {
                assert!(
                    docs.contains(&format!("`{property}`")),
                    "docs/analytics.md does not list property `{property}` of `{name}`"
                );
            }
        }
    }

    #[test]
    fn view_matches_the_sidebar_union() {
        let sidebar = manifest_file("../../src/components/Sidebar.tsx");
        let union = sidebar
            .split("export type View =")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("Sidebar.tsx exports a View union");
        let ts_names: Vec<&str> = union
            .split('|')
            .map(|v| v.trim().trim_matches('"'))
            .filter(|v| !v.is_empty())
            .collect();
        for name in &ts_names {
            assert!(
                serde_json::from_value::<View>(json!(name)).is_ok(),
                "Sidebar.tsx view \"{name}\" is missing from analytics::View"
            );
        }
        for view in every_view() {
            let name = serde_json::to_value(view).unwrap();
            assert!(
                ts_names.contains(&name.as_str().unwrap()),
                "analytics::View {view:?} is not in the Sidebar.tsx union"
            );
        }
    }

    #[test]
    fn desktop_normalizes_xdg_current_desktop() {
        for (xdg, desktop) in [
            ("KDE", Desktop::Kde),
            ("ubuntu:GNOME", Desktop::Gnome),
            ("Hyprland", Desktop::Hyprland),
            ("sway", Desktop::Sway),
            ("COSMIC", Desktop::Cosmic),
            ("X-Cinnamon", Desktop::Other),
            ("", Desktop::Other),
        ] {
            assert_eq!(Desktop::from_xdg(xdg), desktop, "{xdg:?}");
        }
    }

    #[test]
    fn distro_comes_from_the_os_release_id_line() {
        assert_eq!(distro_id("NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=40\n"), "fedora");
        assert_eq!(distro_id("ID_LIKE=debian\nID=\"pop\"\n"), "pop");
        assert_eq!(distro_id("NAME=Mystery\n"), "unknown");
    }

    #[test]
    fn chat_provider_maps_the_settings_presets() {
        for (preset, provider) in [
            ("ollama", ChatProvider::Ollama),
            ("lmstudio", ChatProvider::Lmstudio),
            ("openai", ChatProvider::Openai),
            ("openrouter", ChatProvider::Openrouter),
            ("custom", ChatProvider::Custom),
            ("something-else", ChatProvider::Custom),
        ] {
            let chat = ChatConfig { provider: preset.to_string(), ..ChatConfig::default() };
            assert_eq!(ChatProvider::from_config(&chat), provider, "{preset}");
        }
    }

    #[test]
    fn count_bucket_edges() {
        for (count, bucket) in [
            (0, CountBucket::Zero),
            (1, CountBucket::Under100),
            (99, CountBucket::Under100),
            (100, CountBucket::Under1000),
            (999, CountBucket::Under1000),
            (1000, CountBucket::Thousands),
        ] {
            assert_eq!(CountBucket::of(count), bucket, "{count}");
        }
    }

    #[test]
    fn build_env_treats_empty_values_as_unset() {
        assert!(Endpoint::from_build_env(None, Some("http://x")).is_none());
        assert!(Endpoint::from_build_env(Some(""), Some("http://x")).is_none());
        let endpoint = Endpoint::from_build_env(Some("phc_k"), Some(" ")).unwrap();
        assert_eq!((endpoint.host.as_str(), endpoint.api_key.as_str()), (DEFAULT_HOST, "phc_k"));
        let endpoint = Endpoint::from_build_env(Some("phc_k"), Some("http://127.0.0.1:9/")).unwrap();
        assert_eq!(endpoint.host, "http://127.0.0.1:9");
    }

    #[tokio::test]
    async fn send_honors_the_opt_out_read_fresh_from_config() {
        let dir = tempfile::tempdir().unwrap();
        let (host, mut requests) = fake_posthog().await;
        let analytics = Analytics::new(Source::Daemon, dir.path().to_path_buf(), Some(Endpoint::new(&host, "test")));

        write_config(dir.path(), false);
        analytics.send(vec![Stamped::now(Event::PrivateModeToggled { enabled: true })]).await;
        assert!(requests.try_recv().is_err(), "sent while analytics = false");
        assert!(!dir.path().join("install_id").exists(), "created an install id while opted out");

        write_config(dir.path(), true);
        analytics.send(vec![Stamped::now(Event::PrivateModeToggled { enabled: false })]).await;
        let (path, body) = requests.try_recv().expect("nothing sent after opting back in");
        assert_eq!(path, "/batch/");
        assert_eq!(body["api_key"], "test");
        assert_eq!(body["batch"][0]["event"], "private_mode_toggled");
        assert_eq!(body["batch"][0]["properties"]["enabled"], false);
        assert_eq!(body["batch"][0]["properties"]["source"], "daemon");
        assert_eq!(
            body["batch"][0]["distinct_id"],
            fs::read_to_string(dir.path().join("install_id")).unwrap()
        );
    }

    #[tokio::test]
    async fn send_without_a_config_file_sends_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (host, mut requests) = fake_posthog().await;
        let analytics = Analytics::new(Source::Ui, dir.path().to_path_buf(), Some(Endpoint::new(&host, "test")));
        analytics.send(vec![Stamped::now(Event::AppOpened)]).await;
        assert!(requests.try_recv().is_err());
    }
}
