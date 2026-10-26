//! The app's analytics queue. Events wait in memory and go out every 60
//! seconds and on exit. A failed batch is dropped, never retried.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rewindos_core::analytics::{Analytics, Event, Stamped, View};
use serde::Deserialize;

const FLUSH_EVERY: Duration = Duration::from_secs(60);
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(2);

pub struct Queue {
    analytics: Analytics,
    pending: Mutex<Vec<Stamped>>,
}

impl Queue {
    pub fn new(analytics: Analytics) -> Self {
        Self {
            analytics,
            pending: Mutex::new(Vec::new()),
        }
    }

    pub fn push(&self, event: Event) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Stamped::now(event));
    }

    async fn flush(&self) {
        let events = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        self.analytics.send(events).await;
    }
}

pub fn spawn_flusher(queue: Arc<Queue>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(FLUSH_EVERY).await;
            queue.flush().await;
        }
    });
}

/// Blocks quitting for at most `EXIT_FLUSH_TIMEOUT`, so a dead network can't hang it.
pub fn flush_on_exit(queue: &Queue) {
    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(EXIT_FLUSH_TIMEOUT, queue.flush()).await;
    });
}

/// The events the frontend may report through `track_event`. Everything else
/// is emitted in Rust where the action happens.
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UiEvent {
    ViewOpened { view: View },
}

impl From<UiEvent> for Event {
    fn from(event: UiEvent) -> Self {
        match event {
            UiEvent::ViewOpened { view } => Event::ViewOpened { view },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rewindos_core::analytics::{Endpoint, Source};
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Result<UiEvent, serde_json::Error> {
        serde_json::from_value(value)
    }

    /// Forwards each request body, then answers 200.
    fn fake_posthog() -> (String, std::sync::mpsc::Receiver<serde_json::Value>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let host = format!("http://{}", server.server_addr().to_ip().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                tx.send(serde_json::from_str(&body).unwrap()).unwrap();
                request.respond(tiny_http::Response::empty(200)).unwrap();
            }
        });
        (host, rx)
    }

    #[tokio::test]
    async fn flush_sends_the_queue_as_one_batch_then_drains() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.toml"), "[privacy]\nanalytics = true\n").unwrap();
        let (host, requests) = fake_posthog();
        let queue = Queue::new(Analytics::new(
            Source::Ui,
            dir.path().to_path_buf(),
            Some(Endpoint::new(&host, "test")),
        ));

        queue.push(Event::AppOpened);
        queue.push(Event::ViewOpened { view: View::Journal });
        queue.flush().await;
        queue.flush().await;

        let batch = requests.try_recv().expect("first flush sent nothing");
        let names: Vec<_> = batch["batch"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect();
        assert_eq!(names, [json!("app_opened"), json!("view_opened")]);
        assert_eq!(batch["batch"][1]["properties"]["view"], "journal");
        assert_eq!(batch["batch"][1]["properties"]["source"], "ui");
        assert!(requests.try_recv().is_err(), "second flush resent the batch");
    }

    #[test]
    fn track_event_accepts_known_views() {
        assert_eq!(
            parse(json!({ "event": "view_opened", "view": "ask" })).unwrap(),
            UiEvent::ViewOpened { view: View::Ask }
        );
    }

    #[test]
    fn track_event_rejects_unknown_views_and_events() {
        assert!(parse(json!({ "event": "view_opened", "view": "timeline" })).is_err());
        assert!(parse(json!({ "event": "view_opened" })).is_err());
        assert!(parse(json!({ "event": "app_opened" })).is_err());
        assert!(parse(json!({ "event": "search_performed", "mode": "keyword", "has_filters": false })).is_err());
        assert!(parse(json!({ "view": "ask" })).is_err());
    }
}
