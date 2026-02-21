mod capture;
mod detect;
mod pipeline;
mod service;
mod window_info;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use clap::{Parser, Subcommand};
use rewindos_core::config::{init_logging, AppConfig};
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
use rewindos_core::hasher;
use rewindos_core::ocr;
use tracing::{info, warn};

#[derive(Parser)]
#[command(name = "rewindos-daemon", about = "RewindOS capture daemon")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the daemon (default when no subcommand given)
    Run,
    /// Pause screen capture
    Pause,
    /// Resume screen capture
    Resume,
    /// Show daemon status
    Status,
    /// Backfill embeddings for existing screenshots
    Backfill {
        /// Number of screenshots to process per batch
        #[arg(long, default_value = "50")]
        batch_size: usize,
    },
    /// Recompress existing screenshots with lossy WebP + downscaling
    Recompress {
        /// WebP quality (0-100)
        #[arg(long, default_value = "80")]
        quality: u8,
        /// Maximum image width in pixels
        #[arg(long, default_value = "1920")]
        max_width: u32,
        /// Thumbnail width in pixels
        #[arg(long, default_value = "320")]
        thumb_width: u32,
        /// Perform a dry run without modifying files
        #[arg(long)]
        dry_run: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command.unwrap_or(Command::Run) {
        Command::Run => run_daemon().await,
        Command::Pause => dbus_client_call("Pause").await,
        Command::Resume => dbus_client_call("Resume").await,
        Command::Status => dbus_client_status().await,
        Command::Backfill { batch_size } => run_backfill(batch_size).await,
        Command::Recompress {
            quality,
            max_width,
            thumb_width,
            dry_run,
        } => run_recompress(quality, max_width, thumb_width, dry_run).await,
    }
}

async fn dbus_client_call(method: &str) -> anyhow::Result<()> {
    let conn = zbus::Connection::session().await?;
    conn.call_method(
        Some("com.rewindos.Daemon"),
        "/com/rewindos/Daemon",
        Some("com.rewindos.Daemon"),
        method,
        &(),
    )
    .await?;
    println!("{method} command sent successfully");
    Ok(())
}

async fn dbus_client_status() -> anyhow::Result<()> {
    let conn = zbus::Connection::session().await?;
    let reply = conn
        .call_method(
            Some("com.rewindos.Daemon"),
            "/com/rewindos/Daemon",
            Some("com.rewindos.Daemon"),
            "GetStatus",
            &(),
        )
        .await?;

    let status_json: String = reply.body().deserialize()?;
    let status: serde_json::Value = serde_json::from_str(&status_json)?;

    // Pretty-print
    println!("{}", serde_json::to_string_pretty(&status)?);
    Ok(())
}

async fn run_backfill(batch_size: usize) -> anyhow::Result<()> {
    init_logging();

    let config = AppConfig::load()?;
    let db_path = config.db_path()?;
    let db = Database::open(&db_path)?;

    let client = OllamaClient::new(&config.semantic.ollama_url, &config.semantic.model);

    if !client.health_check().await {
        anyhow::bail!(
            "Ollama is not reachable at {}. Start Ollama and ensure '{}' model is pulled.",
            config.semantic.ollama_url,
            config.semantic.model,
        );
    }

    println!("Connected to Ollama, starting backfill...");

    let mut total_processed = 0u64;

    loop {
        let pending = db.get_pending_embeddings(batch_size)?;
        if pending.is_empty() {
            break;
        }

        let batch_total = pending.len();

        for (i, (screenshot_id, text)) in pending.into_iter().enumerate() {
            total_processed += 1;
            print!(
                "\r[{total_processed}] Embedding screenshot #{screenshot_id} ({}/{batch_total})...",
                i + 1,
            );

            match client.embed(&text).await {
                Ok(Some(embedding)) => {
                    db.insert_embedding(screenshot_id, &embedding)?;
                }
                Ok(None) => {
                    eprintln!("\nOllama became unavailable, stopping.");
                    return Ok(());
                }
                Err(e) => {
                    eprintln!("\nFailed to embed screenshot #{screenshot_id}: {e}");
                }
            }
        }
    }

    println!("\nBackfill complete. Processed {total_processed} screenshots.");
    Ok(())
}

async fn run_recompress(
    quality: u8,
    max_width: u32,
    thumb_width: u32,
    dry_run: bool,
) -> anyhow::Result<()> {
    init_logging();

    let config = AppConfig::load()?;
    let db_path = config.db_path()?;
    let db = Arc::new(Mutex::new(Database::open(&db_path)?));

    let all = db.lock().unwrap().get_all_screenshot_paths()?;
    let total = all.len();

    if total == 0 {
        println!("No screenshots found.");
        return Ok(());
    }

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);

    println!(
        "Recompressing {total} screenshots (quality={quality}, max_width={max_width}, workers={workers}, dry_run={dry_run})"
    );

    let processed = Arc::new(AtomicU64::new(0));
    let skipped = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let saved_bytes = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let done_count = Arc::new(AtomicU64::new(0));
    let semaphore = Arc::new(tokio::sync::Semaphore::new(workers));

    let mut handles = Vec::with_capacity(total);

    for (_i, (id, file_path, thumb_path)) in all.into_iter().enumerate() {
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let db = db.clone();
        let processed = processed.clone();
        let skipped = skipped.clone();
        let errors = errors.clone();
        let saved_bytes = saved_bytes.clone();
        let done_count = done_count.clone();
        let total = total;

        let handle = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let path = std::path::PathBuf::from(&file_path);
            if !path.exists() {
                skipped.fetch_add(1, Ordering::Relaxed);
                done_count.fetch_add(1, Ordering::Relaxed);
                return;
            }

            let original_size = match std::fs::metadata(&path) {
                Ok(m) => m.len() as i64,
                Err(_) => {
                    skipped.fetch_add(1, Ordering::Relaxed);
                    done_count.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };

            let img = match image::open(&path) {
                Ok(img) => img,
                Err(_e) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    done_count.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };

            let downscaled = hasher::downscale_for_storage(&img, max_width);

            if dry_run {
                let encoder = match webp::Encoder::from_image(&downscaled) {
                    Ok(e) => e,
                    Err(_) => {
                        errors.fetch_add(1, Ordering::Relaxed);
                        done_count.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                };
                let webp_data = encoder.encode(quality as f32);
                let new_size = webp_data.len() as i64;
                saved_bytes.fetch_add(original_size - new_size, Ordering::Relaxed);
                processed.fetch_add(1, Ordering::Relaxed);
            } else {
                let new_size = match hasher::save_webp(&downscaled, &path, quality) {
                    Ok(s) => s as i64,
                    Err(_e) => {
                        errors.fetch_add(1, Ordering::Relaxed);
                        done_count.fetch_add(1, Ordering::Relaxed);
                        return;
                    }
                };

                if let Some(ref tp) = thumb_path {
                    let thumb = hasher::create_thumbnail(&downscaled, thumb_width);
                    let _ = hasher::save_webp(&thumb, std::path::Path::new(tp), 75);
                }

                if let Ok(db) = db.lock() {
                    let _ = db.update_screenshot_file(
                        id,
                        downscaled.width() as i32,
                        downscaled.height() as i32,
                        new_size,
                    );
                }

                saved_bytes.fetch_add(original_size - new_size, Ordering::Relaxed);
                processed.fetch_add(1, Ordering::Relaxed);
            }

            let n = done_count.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 100 == 0 || n as usize == total {
                eprint!("\r[{n}/{total}] ...");
            }
        });

        handles.push(handle);
    }

    for h in handles {
        let _ = h.await;
    }

    let processed = processed.load(Ordering::Relaxed);
    let skipped = skipped.load(Ordering::Relaxed);
    let errors = errors.load(Ordering::Relaxed);
    let saved_bytes = saved_bytes.load(Ordering::Relaxed);

    println!("\n\nDone. Processed: {processed}, Skipped: {skipped}, Errors: {errors}");
    println!(
        "Total space saved: {} ({})",
        format_bytes(saved_bytes),
        if dry_run { "estimated" } else { "actual" }
    );

    Ok(())
}

fn format_bytes(bytes: i64) -> String {
    let abs = bytes.unsigned_abs();
    let sign = if bytes < 0 { "-" } else { "" };
    if abs < 1024 {
        format!("{sign}{abs} B")
    } else if abs < 1024 * 1024 {
        format!("{sign}{:.1} KB", abs as f64 / 1024.0)
    } else if abs < 1024 * 1024 * 1024 {
        format!("{sign}{:.1} MB", abs as f64 / (1024.0 * 1024.0))
    } else {
        format!("{sign}{:.2} GB", abs as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

async fn run_daemon() -> anyhow::Result<()> {
    init_logging();

    let config = AppConfig::load()?;
    config.ensure_dirs()?;

    info!(
        interval = config.capture.interval_seconds,
        retention_days = config.storage.retention_days,
        "rewindos-daemon starting"
    );

    // Check tesseract availability
    if config.ocr.enabled && !ocr::is_tesseract_available().await {
        warn!("tesseract not found — OCR will be disabled");
    }

    // Open database and run migrations
    let db_path = config.db_path()?;
    let db = Database::open(&db_path)?;
    info!(path = %db_path.display(), "database opened");
    let db = Arc::new(Mutex::new(db));

    // Auto-detect Ollama: always probe regardless of config.semantic.enabled
    let ollama_client = {
        let client = OllamaClient::new(&config.semantic.ollama_url, &config.semantic.model);
        if client.health_check().await {
            let model = config.semantic.model.clone();
            if !client.has_model(&model).await {
                info!(model = %model, "embedding model not found, pulling...");
                match client.pull_model(&model).await {
                    Ok(true) => info!(model = %model, "embedding model pulled successfully"),
                    Ok(false) => {
                        warn!(model = %model, "failed to pull embedding model (timeout or unreachable)")
                    }
                    Err(e) => warn!(model = %model, error = %e, "error pulling embedding model"),
                }
            }
            info!(url = %config.semantic.ollama_url, "Ollama detected — semantic search enabled");
            Some(Arc::new(client))
        } else {
            info!(
                "Ollama not reachable at {} — using keyword-only search",
                config.semantic.ollama_url
            );
            None
        }
    };

    // Connect to D-Bus session bus
    let dbus_conn = zbus::Connection::session().await?;

    // Detect desktop environment and session type
    let desktop = detect::detect_desktop();
    let session = detect::detect_session();
    info!(desktop = ?desktop, session = ?session, "detected environment");

    // Create window info provider
    let (window_info, kwin_window_info) =
        detect::create_window_info_provider(&desktop, &session, &dbus_conn).await;

    // Create capture backend
    let capture_backend = detect::create_capture_backend(&desktop, &session, &dbus_conn)?;
    let capture_backend_name = capture_backend.name().to_string();

    // Start the capture pipeline
    let pipeline_handle =
        pipeline::start_pipeline(&config, db.clone(), capture_backend, window_info.clone()).await?;

    info!("capture pipeline started");

    // Spawn background embedding backfill if Ollama is available
    if let Some(ref client) = ollama_client {
        let backfill_db = db.clone();
        let backfill_client = client.clone();
        tokio::spawn(async move {
            info!("starting background embedding backfill");
            let mut total = 0u64;
            loop {
                let pending = {
                    let db = backfill_db.lock().unwrap_or_else(|e| e.into_inner());
                    match db.get_pending_embeddings(50) {
                        Ok(p) => p,
                        Err(e) => {
                            warn!(error = %e, "backfill: failed to get pending embeddings");
                            break;
                        }
                    }
                };

                if pending.is_empty() {
                    if total > 0 {
                        info!(total, "background embedding backfill complete");
                    }
                    break;
                }

                for (screenshot_id, text) in pending {
                    match backfill_client.embed(&text).await {
                        Ok(Some(embedding)) => {
                            let db = backfill_db.lock().unwrap_or_else(|e| e.into_inner());
                            if let Err(e) = db.insert_embedding(screenshot_id, &embedding) {
                                warn!(screenshot_id, error = %e, "backfill: failed to store embedding");
                            } else {
                                total += 1;
                            }
                        }
                        Ok(None) => {
                            warn!("backfill: Ollama became unavailable, stopping");
                            return;
                        }
                        Err(e) => {
                            warn!(screenshot_id, error = %e, "backfill: failed to embed");
                        }
                    }
                    // Small delay to avoid overwhelming Ollama
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        });
    }

    // Register D-Bus service
    let dbus_service = service::DaemonService {
        db: db.clone(),
        config: Arc::new(config.clone()),
        metrics: pipeline_handle.metrics.clone(),
        is_capturing: pipeline_handle.is_capturing.clone(),
        start_time: Instant::now(),
        ollama_client,
        kwin_window_info: kwin_window_info.clone(),
        capture_backend_name,
        window_info_provider_name: window_info.name().to_string(),
        desktop_name: desktop.to_string(),
        session_name: session.to_string(),
    };

    dbus_conn
        .object_server()
        .at("/com/rewindos/Daemon", dbus_service)
        .await?;

    dbus_conn.request_name("com.rewindos.Daemon").await?;
    info!("D-Bus service registered at com.rewindos.Daemon");

    // Start window info provider (must be after D-Bus service registration
    // so KWin script can call back to us)
    if let Err(e) = window_info.start().await {
        warn!(error = %e, "failed to start window info provider");
    }

    // Wait for shutdown signal
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("received SIGINT, shutting down");
        }
        _ = sigterm.recv() => {
            info!("received SIGTERM, shutting down");
        }
    }

    // Graceful shutdown
    if let Err(e) = window_info.stop().await {
        warn!(error = %e, "failed to stop window info provider");
    }
    pipeline_handle.shutdown().await;

    info!("rewindos-daemon stopped");
    Ok(())
}
