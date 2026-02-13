mod capture;
mod detect;
mod pipeline;
mod service;
mod window_info;

use std::sync::{Arc, Mutex};
use std::time::Instant;

use clap::{Parser, Subcommand};
use rewindos_core::config::{init_logging, AppConfig};
use rewindos_core::db::Database;
use rewindos_core::embedding::OllamaClient;
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

    // Construct OllamaClient if semantic search is enabled
    let ollama_client = if config.semantic.enabled {
        let client = OllamaClient::new(&config.semantic.ollama_url, &config.semantic.model);
        if client.health_check().await {
            info!("Ollama connected for semantic search");
            Some(Arc::new(client))
        } else {
            warn!(
                "Ollama not reachable at {}, semantic search will fall back to keyword-only",
                config.semantic.ollama_url
            );
            Some(Arc::new(client))
        }
    } else {
        None
    };

    // Connect to D-Bus session bus
    let dbus_conn = zbus::Connection::session().await?;

    // Detect desktop environment and session type
    let desktop = detect::detect_desktop();
    let session = detect::detect_session();
    info!(desktop = ?desktop, session = ?session, "detected environment");

    // Create window info provider
    let (window_info, kwin_window_info) =
        detect::create_window_info_provider(&desktop, &session, &dbus_conn);

    // Create capture backend
    let capture_backend = detect::create_capture_backend(&desktop, &session, &dbus_conn)?;

    // Start the capture pipeline
    let pipeline_handle =
        pipeline::start_pipeline(&config, db.clone(), capture_backend, window_info.clone())
            .await?;

    info!("capture pipeline started");

    // Register D-Bus service
    let dbus_service = service::DaemonService {
        db: db.clone(),
        metrics: pipeline_handle.metrics.clone(),
        is_capturing: pipeline_handle.is_capturing.clone(),
        start_time: Instant::now(),
        ollama_client,
        kwin_window_info: kwin_window_info.clone(),
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
    let mut sigterm =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;

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
