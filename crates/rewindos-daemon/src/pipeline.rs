use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
use rewindos_core::hasher::{
    self, PerceptualHasher,
};
use rewindos_core::ocr;
use rewindos_core::schema::{EmbedRequest, NewScreenshot, OcrStatus, ProcessedFrame, RawFrame};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::capture::CaptureManager;
use crate::window_info::WindowTracker;

/// Shared pipeline metrics, accessible from D-Bus GetStatus.
pub struct PipelineMetrics {
    pub frames_captured: AtomicU64,
    pub frames_deduplicated: AtomicU64,
    pub frames_ocr_pending: AtomicU64,
    pub frames_indexed: AtomicU64,
}

impl PipelineMetrics {
    pub fn new() -> Self {
        Self {
            frames_captured: AtomicU64::new(0),
            frames_deduplicated: AtomicU64::new(0),
            frames_ocr_pending: AtomicU64::new(0),
            frames_indexed: AtomicU64::new(0),
        }
    }
}

/// Handle to the running pipeline, used for shutdown.
pub struct PipelineHandle {
    pub metrics: Arc<PipelineMetrics>,
    pub is_capturing: Arc<AtomicBool>,
    capture_task: tokio::task::JoinHandle<()>,
    hash_task: tokio::task::JoinHandle<()>,
    ocr_task: tokio::task::JoinHandle<()>,
    index_task: tokio::task::JoinHandle<()>,
    embed_task: tokio::task::JoinHandle<()>,
}

impl PipelineHandle {
    /// Gracefully shut down all pipeline tasks.
    /// Waits up to 30 seconds for pending work to flush.
    pub async fn shutdown(self) {
        info!("shutting down pipeline");
        self.is_capturing.store(false, Ordering::SeqCst);

        // Abort the capture task first — it's the source.
        // Other tasks will drain once their channels close.
        self.capture_task.abort();
        let _ = self.capture_task.await;

        // Wait for downstream tasks to finish draining
        let timeout = tokio::time::Duration::from_secs(30);
        let _ = tokio::time::timeout(timeout, async {
            let _ = self.hash_task.await;
            let _ = self.ocr_task.await;
            let _ = self.index_task.await;
            let _ = self.embed_task.await;
        })
        .await;

        info!("pipeline shutdown complete");
    }
}

/// Start the 5-stage capture pipeline.
///
/// Returns a handle for shutdown and metrics access.
pub async fn start_pipeline(
    config: &AppConfig,
    db: Arc<Mutex<Database>>,
    dbus_conn: zbus::Connection,
    window_tracker: Arc<WindowTracker>,
) -> Result<PipelineHandle, crate::capture::CaptureError> {
    let metrics = Arc::new(PipelineMetrics::new());
    let is_capturing = Arc::new(AtomicBool::new(true));

    let screenshots_dir = config
        .screenshots_dir()
        .map_err(|e| crate::capture::CaptureError::KWin(format!("config error: {e}")))?;

    // Channels connecting pipeline stages (bounded, capacity 32)
    let (raw_tx, raw_rx) = mpsc::channel::<RawFrame>(32);
    let (processed_tx, processed_rx) = mpsc::channel::<ProcessedFrame>(32);
    let (ocr_tx, ocr_rx) = mpsc::channel::<rewindos_core::schema::OcrResult>(32);
    let (embed_tx, embed_rx) = mpsc::channel::<EmbedRequest>(32);

    // Create CaptureManager (KWin-based, no separate thread needed)
    let capture = CaptureManager::start(
        &config.capture,
        &config.privacy,
        dbus_conn,
        is_capturing.clone(),
        window_tracker,
    )
    .await?;

    // Stage 1: Capture — KWin screenshot → RawFrame
    let capture_task = {
        let metrics = metrics.clone();
        let is_capturing = is_capturing.clone();
        tokio::spawn(async move {
            run_capture_stage(capture, raw_tx, metrics, is_capturing).await;
        })
    };

    // Stage 2: Hash + dedup + save WebP
    let hash_task = {
        let config = config.clone();
        let db = db.clone();
        let metrics = metrics.clone();
        let screenshots_dir = screenshots_dir.clone();
        tokio::spawn(async move {
            run_hash_stage(
                &config,
                db,
                raw_rx,
                processed_tx,
                metrics,
                screenshots_dir,
            )
            .await;
        })
    };

    // Stage 3: OCR
    let ocr_task = {
        let config = config.clone();
        let db = db.clone();
        let metrics = metrics.clone();
        tokio::spawn(async move {
            run_ocr_stage(&config, db, processed_rx, ocr_tx, metrics).await;
        })
    };

    // Stage 4: Index into SQLite
    let index_task = {
        let db = db.clone();
        let metrics = metrics.clone();
        let semantic_enabled = config.semantic.enabled;
        tokio::spawn(async move {
            run_index_stage(db, ocr_rx, metrics, embed_tx, semantic_enabled).await;
        })
    };

    // Stage 5: Embedding (optional, only if semantic search enabled)
    let embed_task = {
        let db = db.clone();
        let semantic_config = config.semantic.clone();
        tokio::spawn(async move {
            run_embed_stage(db, embed_rx, &semantic_config).await;
        })
    };

    Ok(PipelineHandle {
        metrics,
        is_capturing,
        capture_task,
        hash_task,
        ocr_task,
        index_task,
        embed_task,
    })
}

// -- Stage 1: Capture --

async fn run_capture_stage(
    capture: CaptureManager,
    raw_tx: mpsc::Sender<RawFrame>,
    metrics: Arc<PipelineMetrics>,
    is_capturing: Arc<AtomicBool>,
) {
    info!("capture stage started");

    while is_capturing.load(Ordering::SeqCst) {
        match capture.next_frame().await {
            Some(frame) => {
                metrics.frames_captured.fetch_add(1, Ordering::Relaxed);
                if raw_tx.send(frame).await.is_err() {
                    debug!("hash stage channel closed, stopping capture");
                    break;
                }
            }
            None => {
                info!("capture stream ended");
                break;
            }
        }
    }
}

// -- Stage 2: Hash + Dedup + Save --

async fn run_hash_stage(
    config: &AppConfig,
    db: Arc<Mutex<Database>>,
    mut raw_rx: mpsc::Receiver<RawFrame>,
    processed_tx: mpsc::Sender<ProcessedFrame>,
    metrics: Arc<PipelineMetrics>,
    screenshots_dir: PathBuf,
) {
    let hasher = PerceptualHasher::new();
    let threshold = config.capture.change_threshold;
    let quality = config.storage.screenshot_quality;
    let thumb_width = config.storage.thumbnail_width;

    info!("hash stage started");

    while let Some(frame) = raw_rx.recv().await {
        let timestamp_ms = frame.timestamp;
        let timestamp_secs = timestamp_ms / 1000;

        // Compute perceptual hash (CPU-bound)
        let pixels = frame.pixels.clone();
        let width = frame.width;
        let height = frame.height;
        let hasher_ref = &hasher;

        let image = match hasher::image_from_rgba(&pixels, width, height) {
            Ok(img) => img,
            Err(e) => {
                warn!("failed to create image from frame: {e}");
                continue;
            }
        };

        let hash = hasher_ref.hash_image(&image);

        // Check for duplicates against recent hashes
        let db_clone = db.clone();
        let hash_clone = hash.clone();
        let is_dup = tokio::task::spawn_blocking(move || {
            let db = db_clone.lock().unwrap_or_else(|e| e.into_inner());
            let since = timestamp_secs - 30; // last 30 seconds
            match db.get_recent_hashes(since, 10) {
                Ok(recent) => PerceptualHasher::is_duplicate(&hash_clone, &recent, threshold),
                Err(e) => {
                    warn!("failed to get recent hashes: {e}");
                    false
                }
            }
        })
        .await
        .unwrap_or(false);

        if is_dup {
            metrics.frames_deduplicated.fetch_add(1, Ordering::Relaxed);
            debug!(timestamp_ms, "frame deduplicated, skipping");
            continue;
        }

        // Save WebP screenshot and thumbnail
        let file_path = hasher::screenshot_path(&screenshots_dir, timestamp_ms);
        let thumb_path = hasher::thumbnail_path(&screenshots_dir, timestamp_ms);

        let img_for_save = image.clone();
        let file_path_clone = file_path.clone();
        let thumb_path_clone = thumb_path.clone();
        let save_result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
            let file_size = hasher::save_webp(&img_for_save, &file_path_clone, quality)
                .map_err(|e| format!("save webp: {e}"))?;
            let thumbnail = hasher::create_thumbnail(&img_for_save, thumb_width);
            hasher::save_webp(&thumbnail, &thumb_path_clone, 75)
                .map_err(|e| format!("save thumbnail: {e}"))?;
            Ok(file_size)
        })
        .await;

        let file_size = match save_result {
            Ok(Ok(size)) => size,
            Ok(Err(e)) => {
                error!("failed to save screenshot: {e}");
                continue;
            }
            Err(e) => {
                error!("save task panicked: {e}");
                continue;
            }
        };

        // Insert into database
        let new_screenshot = NewScreenshot {
            timestamp: timestamp_secs,
            timestamp_ms,
            app_name: frame.app_name,
            window_title: frame.window_title,
            window_class: frame.window_class,
            file_path: file_path.to_string_lossy().to_string(),
            thumbnail_path: Some(thumb_path.to_string_lossy().to_string()),
            width: width as i32,
            height: height as i32,
            file_size_bytes: file_size as i64,
            perceptual_hash: hash,
        };

        let db_clone = db.clone();
        let insert_result = tokio::task::spawn_blocking(move || {
            let db = db_clone.lock().unwrap_or_else(|e| e.into_inner());
            db.insert_screenshot(&new_screenshot)
        })
        .await;

        let screenshot_id = match insert_result {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => {
                error!("failed to insert screenshot: {e}");
                continue;
            }
            Err(e) => {
                error!("insert task panicked: {e}");
                continue;
            }
        };

        metrics.frames_ocr_pending.fetch_add(1, Ordering::Relaxed);

        info!(
            screenshot_id,
            file_size,
            path = %file_path.display(),
            "saved screenshot"
        );

        let processed = ProcessedFrame {
            screenshot_id,
            file_path,
            thumbnail_path: thumb_path,
            timestamp: timestamp_ms,
        };

        if processed_tx.send(processed).await.is_err() {
            debug!("OCR stage channel closed");
            break;
        }
    }

    info!("hash stage finished");
}

// -- Stage 3: OCR --

async fn run_ocr_stage(
    config: &AppConfig,
    db: Arc<Mutex<Database>>,
    mut processed_rx: mpsc::Receiver<ProcessedFrame>,
    ocr_tx: mpsc::Sender<rewindos_core::schema::OcrResult>,
    metrics: Arc<PipelineMetrics>,
) {
    let lang = config.ocr.tesseract_lang.clone();
    let ocr_enabled = config.ocr.enabled;
    let max_workers = config.ocr.max_workers as usize;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(max_workers));

    info!(enabled = ocr_enabled, max_workers, "OCR stage started");

    if !ocr_enabled {
        // Drain channel without processing
        while processed_rx.recv().await.is_some() {
            metrics.frames_ocr_pending.fetch_sub(1, Ordering::Relaxed);
        }
        return;
    }

    while let Some(frame) = processed_rx.recv().await {
        let permit = match semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };

        let lang = lang.clone();
        let db = db.clone();
        let ocr_tx = ocr_tx.clone();
        let metrics = metrics.clone();

        tokio::spawn(async move {
            let _permit = permit;

            // Mark as processing
            {
                let db = db.clone();
                let sid = frame.screenshot_id;
                let _ = tokio::task::spawn_blocking(move || {
                    let db = db.lock().unwrap_or_else(|e| e.into_inner());
                    db.update_ocr_status(sid, OcrStatus::Processing)
                })
                .await;
            }

            let result = ocr::run_tesseract(&frame.file_path, &lang).await;

            match result {
                Ok(output) => {
                    metrics.frames_ocr_pending.fetch_sub(1, Ordering::Relaxed);

                    if output.full_text.trim().is_empty() {
                        debug!(screenshot_id = frame.screenshot_id, "no text found in screenshot");
                        let db = db.clone();
                        let sid = frame.screenshot_id;
                        let _ = tokio::task::spawn_blocking(move || {
                            let db = db.lock().unwrap_or_else(|e| e.into_inner());
                            db.update_ocr_status(sid, OcrStatus::Done)
                        })
                        .await;
                        return;
                    }

                    let ocr_result = rewindos_core::schema::OcrResult {
                        screenshot_id: frame.screenshot_id,
                        full_text: output.full_text,
                        bounding_boxes: output.bounding_boxes,
                    };

                    if ocr_tx.send(ocr_result).await.is_err() {
                        debug!("index stage channel closed");
                    }
                }
                Err(e) => {
                    metrics.frames_ocr_pending.fetch_sub(1, Ordering::Relaxed);
                    warn!(screenshot_id = frame.screenshot_id, error = %e, "OCR failed");

                    let db = db.clone();
                    let sid = frame.screenshot_id;
                    let _ = tokio::task::spawn_blocking(move || {
                        let db = db.lock().unwrap_or_else(|e| e.into_inner());
                        db.update_ocr_status(sid, OcrStatus::Failed)
                    })
                    .await;
                }
            }
        });
    }

    info!("OCR stage finished");
}

// -- Stage 4: Index --

async fn run_index_stage(
    db: Arc<Mutex<Database>>,
    mut ocr_rx: mpsc::Receiver<rewindos_core::schema::OcrResult>,
    metrics: Arc<PipelineMetrics>,
    embed_tx: mpsc::Sender<EmbedRequest>,
    semantic_enabled: bool,
) {
    info!("index stage started");

    while let Some(ocr_result) = ocr_rx.recv().await {
        let db = db.clone();
        let metrics = metrics.clone();
        let screenshot_id = ocr_result.screenshot_id;
        let text_for_embed = ocr_result.full_text.clone();

        let result = tokio::task::spawn_blocking(move || {
            let db = db.lock().unwrap_or_else(|e| e.into_inner());

            db.insert_ocr_text(
                ocr_result.screenshot_id,
                &ocr_result.full_text,
                ocr_result.bounding_boxes.len() as i32,
            )?;

            db.insert_bounding_boxes(ocr_result.screenshot_id, &ocr_result.bounding_boxes)?;

            db.update_ocr_status(ocr_result.screenshot_id, OcrStatus::Done)?;

            metrics.frames_indexed.fetch_add(1, Ordering::Relaxed);

            info!(
                screenshot_id = ocr_result.screenshot_id,
                words = ocr_result.bounding_boxes.len(),
                "indexed screenshot"
            );

            Ok::<(), rewindos_core::error::CoreError>(())
        })
        .await;

        match result {
            Ok(Ok(())) => {
                // Forward to embedding stage if semantic search is enabled
                if semantic_enabled && !text_for_embed.trim().is_empty() {
                    let req = EmbedRequest {
                        screenshot_id,
                        text: text_for_embed,
                    };
                    if embed_tx.send(req).await.is_err() {
                        debug!("embed stage channel closed");
                    }
                }
            }
            Ok(Err(e)) => error!("index write failed: {e}"),
            Err(e) => error!("index task panicked: {e}"),
        }
    }

    info!("index stage finished");
}

// -- Stage 5: Embedding --

async fn run_embed_stage(
    db: Arc<Mutex<Database>>,
    mut embed_rx: mpsc::Receiver<EmbedRequest>,
    semantic_config: &rewindos_core::config::SemanticConfig,
) {
    if !semantic_config.enabled {
        // Drain channel without processing
        while embed_rx.recv().await.is_some() {}
        info!("embed stage drained (semantic search disabled)");
        return;
    }

    let client = OllamaClient::new(&semantic_config.ollama_url, &semantic_config.model);

    if !client.health_check().await {
        warn!("Ollama is not reachable at {}, embeddings will be skipped", semantic_config.ollama_url);
    } else {
        info!("embed stage connected to Ollama");
    }

    while let Some(req) = embed_rx.recv().await {
        match client.embed(&req.text).await {
            Ok(Some(embedding)) => {
                let db = db.clone();
                let sid = req.screenshot_id;
                let result = tokio::task::spawn_blocking(move || {
                    let db = db.lock().unwrap_or_else(|e| e.into_inner());
                    db.insert_embedding(sid, &embedding)
                })
                .await;

                match result {
                    Ok(Ok(())) => {
                        debug!(screenshot_id = req.screenshot_id, "embedded screenshot");
                    }
                    Ok(Err(e)) => {
                        warn!(screenshot_id = req.screenshot_id, error = %e, "failed to save embedding");
                    }
                    Err(e) => {
                        error!("embed insert task panicked: {e}");
                    }
                }
            }
            Ok(None) => {
                debug!(screenshot_id = req.screenshot_id, "Ollama unavailable, skipping embedding");
            }
            Err(e) => {
                warn!(screenshot_id = req.screenshot_id, error = %e, "embedding failed");
            }
        }
    }

    info!("embed stage finished");
}
