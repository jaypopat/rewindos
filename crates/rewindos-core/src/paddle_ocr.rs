use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::error::{CoreError, Result};
use crate::ocr::OcrOutput;
use crate::schema::NewBoundingBox;

/// Timeout for an individual OCR request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Timeout for the first spawn (models may need downloading).
const SPAWN_TIMEOUT: Duration = Duration::from_secs(120);

/// PaddleOCR sidecar — manages a Python worker process with lazy spawn and idle timeout.
///
/// The worker is not started until the first OCR request. After `idle_timeout_secs`
/// of inactivity the process is killed to reclaim memory. The next request respawns it.
pub struct PaddleOcrSidecar {
    inner: Mutex<Option<SidecarInner>>,
    last_request: AtomicU64,
    python_bin: String,
    script_path: PathBuf,
    lang: String,
    pub idle_timeout_secs: u64,
}

struct SidecarInner {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

// -- JSONL protocol types --

#[derive(Serialize)]
struct OcrRequest<'a> {
    #[serde(rename = "type")]
    req_type: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_path: Option<&'a str>,
}

#[derive(Deserialize)]
struct OcrResponse {
    status: String,
    full_text: Option<String>,
    bounding_boxes: Option<Vec<SidecarBBox>>,
    word_count: Option<i32>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct SidecarBBox {
    text_content: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    confidence: Option<f64>,
}

impl PaddleOcrSidecar {
    /// Create a new sidecar handle without spawning the process.
    pub fn new(
        python_bin: impl Into<String>,
        script_path: impl Into<PathBuf>,
        lang: impl Into<String>,
        idle_timeout_secs: u64,
    ) -> Self {
        Self {
            inner: Mutex::new(None),
            last_request: AtomicU64::new(0),
            python_bin: python_bin.into(),
            script_path: script_path.into(),
            lang: lang.into(),
            idle_timeout_secs,
        }
    }

    /// Run OCR on an image. Spawns the worker on first call.
    pub async fn run_ocr(&self, image_path: &Path) -> Result<OcrOutput> {
        let mut guard = self.inner.lock().await;

        // Spawn if not running.
        if guard.is_none() {
            let inner = self.spawn_worker().await?;
            *guard = Some(inner);
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.last_request.store(now, Ordering::Relaxed);

        let inner = guard.as_mut().unwrap();
        let result = Self::send_request(inner, image_path).await;

        // If the worker died, clear it so the next call respawns.
        if matches!(&result, Err(e) if e.to_string().contains("broken pipe")
            || e.to_string().contains("EOF"))
        {
            warn!("PaddleOCR worker died, will respawn on next request");
            let _ = inner.child.kill().await;
            *guard = None;
        }

        result
    }

    /// Kill the worker if it has been idle longer than `idle_timeout_secs`.
    /// Called periodically by the reaper task.
    pub async fn kill_if_idle(&self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let last = self.last_request.load(Ordering::Relaxed);

        // last == 0 means never used — nothing to kill.
        if last == 0 {
            return;
        }

        if now.saturating_sub(last) < self.idle_timeout_secs {
            return;
        }

        let mut guard = self.inner.lock().await;
        if let Some(mut inner) = guard.take() {
            info!("killing idle PaddleOCR worker ({}s since last request)", now - last);
            let _ = inner.child.kill().await;
        }
    }

    /// Shut down the worker process cleanly.
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(mut inner) = guard.take() {
            // Close stdin to signal EOF.
            drop(inner.stdin);
            // Give it a moment to exit, then kill.
            let wait = tokio::time::timeout(Duration::from_secs(3), inner.child.wait()).await;
            if wait.is_err() {
                let _ = inner.child.kill().await;
            }
            info!("PaddleOCR worker shut down");
        }
    }

    /// Spawn the Python worker process and verify it responds to a health check.
    async fn spawn_worker(&self) -> Result<SidecarInner> {
        info!(
            python = %self.python_bin,
            script = %self.script_path.display(),
            lang = %self.lang,
            "spawning PaddleOCR worker"
        );

        let mut child = Command::new(&self.python_bin)
            .arg(&self.script_path)
            .arg(&self.lang)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| CoreError::Ocr(format!("failed to spawn PaddleOCR worker: {e}")))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CoreError::Ocr("no stdin on PaddleOCR worker".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CoreError::Ocr("no stdout on PaddleOCR worker".into()))?;

        let mut inner = SidecarInner {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
        };

        // Health check — wait for the worker to load models and respond.
        let health_req = serde_json::to_string(&OcrRequest {
            req_type: "health",
            image_path: None,
        })
        .unwrap();

        inner
            .stdin
            .write_all(health_req.as_bytes())
            .await
            .map_err(|e| CoreError::Ocr(format!("health check write: {e}")))?;
        inner
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| CoreError::Ocr(format!("health check write newline: {e}")))?;
        inner
            .stdin
            .flush()
            .await
            .map_err(|e| CoreError::Ocr(format!("health check flush: {e}")))?;

        let mut line = String::new();
        let read = tokio::time::timeout(SPAWN_TIMEOUT, inner.stdout.read_line(&mut line)).await;

        match read {
            Ok(Ok(0)) => {
                return Err(CoreError::Ocr(
                    "PaddleOCR worker closed stdout during health check".into(),
                ))
            }
            Ok(Ok(_)) => {
                let resp: OcrResponse = serde_json::from_str(line.trim()).map_err(|e| {
                    CoreError::Ocr(format!("health check parse error: {e} (raw: {line})"))
                })?;
                if resp.status != "ok" {
                    return Err(CoreError::Ocr(format!(
                        "health check failed: {}",
                        resp.message.unwrap_or_default()
                    )));
                }
                info!("PaddleOCR worker healthy");
            }
            Ok(Err(e)) => {
                return Err(CoreError::Ocr(format!("health check read error: {e}")))
            }
            Err(_) => {
                return Err(CoreError::Ocr(
                    "PaddleOCR worker health check timed out (models may still be downloading)"
                        .into(),
                ))
            }
        }

        Ok(inner)
    }

    /// Send an OCR request and read the response.
    async fn send_request(inner: &mut SidecarInner, image_path: &Path) -> Result<OcrOutput> {
        let path_str = image_path.to_string_lossy();
        let req = serde_json::to_string(&OcrRequest {
            req_type: "ocr",
            image_path: Some(&path_str),
        })
        .unwrap();

        inner
            .stdin
            .write_all(req.as_bytes())
            .await
            .map_err(|e| CoreError::Ocr(format!("write request: {e}")))?;
        inner
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| CoreError::Ocr(format!("write newline: {e}")))?;
        inner
            .stdin
            .flush()
            .await
            .map_err(|e| CoreError::Ocr(format!("flush: {e}")))?;

        let mut line = String::new();
        let read = tokio::time::timeout(REQUEST_TIMEOUT, inner.stdout.read_line(&mut line)).await;

        match read {
            Ok(Ok(0)) => Err(CoreError::Ocr("PaddleOCR worker EOF".into())),
            Ok(Ok(_)) => {
                let resp: OcrResponse = serde_json::from_str(line.trim()).map_err(|e| {
                    CoreError::Ocr(format!("response parse error: {e} (raw: {line})"))
                })?;

                if resp.status != "ok" {
                    return Err(CoreError::Ocr(format!(
                        "PaddleOCR error: {}",
                        resp.message.unwrap_or_default()
                    )));
                }

                let bounding_boxes = resp
                    .bounding_boxes
                    .unwrap_or_default()
                    .into_iter()
                    .map(|b| NewBoundingBox {
                        text_content: b.text_content,
                        x: b.x,
                        y: b.y,
                        width: b.width,
                        height: b.height,
                        confidence: b.confidence,
                    })
                    .collect();

                Ok(OcrOutput {
                    full_text: resp.full_text.unwrap_or_default(),
                    bounding_boxes,
                    word_count: resp.word_count.unwrap_or(0),
                })
            }
            Ok(Err(e)) => Err(CoreError::Ocr(format!("read response: {e}"))),
            Err(_) => Err(CoreError::Ocr("PaddleOCR request timed out (120s)".into())),
        }
    }
}

/// Locate the paddleocr_worker.py script.
///
/// Search order:
/// 1. `~/.rewindos/paddleocr_worker.py` (user override)
/// 2. `/usr/lib/rewindos/paddleocr_worker.py` (system install)
/// 3. Relative to current executable (dev mode)
pub fn find_worker_script() -> Option<PathBuf> {
    // User override.
    if let Some(home) = dirs::home_dir() {
        let p = home.join(".rewindos/paddleocr_worker.py");
        if p.exists() {
            return Some(p);
        }
    }

    // System install.
    let system = Path::new("/usr/lib/rewindos/paddleocr_worker.py");
    if system.exists() {
        return Some(system.to_path_buf());
    }

    // Dev mode: relative to executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // cargo run puts binary in target/debug/ or target/release/
            for rel in &["../../scripts/paddleocr_worker.py", "../scripts/paddleocr_worker.py"] {
                if let Ok(p) = dir.join(rel).canonicalize() {
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
    }

    None
}

/// Check if PaddleOCR is importable by the system Python.
pub async fn is_paddleocr_available(python_bin: &str) -> bool {
    let output = Command::new(python_bin)
        .args(["-c", "import paddleocr; print('ok')"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .await;
    matches!(output, Ok(o) if o.status.success())
}
