//! Drives meeting recording in response to D-Bus Start/Stop commands. Owns the
//! live `AudioCapture` + a worker thread that feeds windows into a
//! `MeetingSession`, and exposes shared atomics so `get_status` can report state.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rewindos_core::config::AppConfig;
use rewindos_core::db::Database;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

use crate::capture::audio::AudioCapture;
use crate::meeting::postprocess;
use crate::meeting::session::{MeetingSession, Transcribe};
use crate::meeting::whisper::{ensure_model_available, WhisperTranscriber};

/// How long to wait for the mic to produce its first bytes before declaring the
/// capture dead. Working devices stream within a few hundred ms; this only
/// delays the *failure* case, not normal recording.
const CAPTURE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Shown to the user when capture produces no audio at all.
const MIC_NO_AUDIO_MSG: &str =
    "No audio from the selected microphone. The input device or PipeWire graph \
     isn't delivering audio — pick a different mic, or restart the audio stack \
     (systemctl --user restart wireplumber pipewire pipewire-pulse).";

/// Shared, lock-free view of meeting state for `get_status`. `0` means "none".
#[derive(Default)]
pub struct MeetingState {
    pub active: AtomicBool,
    pub meeting_id: AtomicI64,
    pub started_at: AtomicI64,
}

/// Commands sent from the D-Bus handler to the controller task.
pub enum MeetingCmd {
    Start {
        title: Option<String>,
        reply: oneshot::Sender<Result<i64, String>>,
    },
    Stop {
        reply: oneshot::Sender<Result<(), String>>,
    },
}

struct ActiveMeeting {
    meeting_id: i64,
    capture: AudioCapture,
    worker: JoinHandle<MeetingSession>,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Controller event loop. Processes Start/Stop commands serially; only one
/// meeting is active at a time.
pub async fn run(
    mut rx: mpsc::Receiver<MeetingCmd>,
    db: Arc<Mutex<Database>>,
    config: Arc<AppConfig>,
    state: Arc<MeetingState>,
) {
    let mut active: Option<ActiveMeeting> = None;
    while let Some(cmd) = rx.recv().await {
        match cmd {
            MeetingCmd::Start { title, reply } => {
                let res = start(&db, &config, &state, &mut active, title).await;
                let _ = reply.send(res);
            }
            MeetingCmd::Stop { reply } => {
                let res = stop(&db, &config, &state, &mut active).await;
                let _ = reply.send(res);
            }
        }
    }
}

async fn start(
    db: &Arc<Mutex<Database>>,
    config: &Arc<AppConfig>,
    state: &Arc<MeetingState>,
    active: &mut Option<ActiveMeeting>,
    title: Option<String>,
) -> Result<i64, String> {
    if active.is_some() {
        return Err("a meeting is already being recorded".to_string());
    }
    let model_path = ensure_model_available(config).map_err(|e| e.to_string())?;
    let meetings_dir = config.meetings_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&meetings_dir).map_err(|e| e.to_string())?;

    let started_at = now_unix();
    let id = {
        let db = db.clone();
        tokio::task::spawn_blocking(move || {
            let db = db.lock().unwrap_or_else(|e| e.into_inner());
            db.insert_meeting(started_at, title.as_deref(), None)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    };

    let keep_audio = config.meeting.keep_audio;
    let mic_source = {
        let m = config.meeting.mic_source.clone();
        if m.is_empty() {
            None
        } else {
            Some(m)
        }
    };
    let mic_path = meetings_dir.join(format!("{id}-mic.opus"));
    let sys_path = meetings_dir.join(format!("{id}-system.opus"));
    // Writers create these files up front; keep paths to clean them up if setup
    // fails (e.g. the capture gate trips) so empty headers don't accumulate.
    let cleanup_paths = [mic_path.clone(), sys_path.clone()];
    let n_threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4);
    let db_for_session = db.clone();

    // Load the model, open writers, start capture, and spawn the drain worker —
    // all blocking, so do it off the async runtime.
    let setup = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let transcriber: Arc<dyn Transcribe> = Arc::new(
            WhisperTranscriber::load(&model_path, n_threads).map_err(|e| e.to_string())?,
        );
        let session = MeetingSession::new(
            id,
            db_for_session,
            transcriber,
            keep_audio,
            mic_path,
            sys_path,
        )
        .map_err(|e| e.to_string())?;
        let (capture, rx_windows) = AudioCapture::start(mic_source).map_err(|e| e.to_string())?;

        // Fail fast if the mic delivers nothing. A working device starts
        // streaming within a few hundred ms; if no bytes arrive at all, the
        // PipeWire graph is wedged or the device is dead — recording would just
        // produce an empty file and a blank transcript. Surface that instead.
        let deadline = Instant::now() + CAPTURE_PROBE_TIMEOUT;
        while capture.mic_bytes() == 0 {
            if Instant::now() >= deadline {
                capture.stop();
                return Err(MIC_NO_AUDIO_MSG.to_string());
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let worker = std::thread::spawn(move || -> MeetingSession {
            let mut session = session;
            while let Ok(window) = rx_windows.recv() {
                if let Err(e) = session.process_window(&window) {
                    warn!(error = %e, "meeting: processing window failed");
                }
            }
            session
        });
        Ok((capture, worker))
    })
    .await
    .map_err(|e| e.to_string())?;
    let (capture, worker) = match setup {
        Ok(cw) => cw,
        Err(e) => {
            // Recording never started — remove the empty meeting row and any
            // empty audio files the writers created so neither lingers.
            for p in &cleanup_paths {
                let _ = std::fs::remove_file(p);
            }
            let db = db.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let db = db.lock().unwrap_or_else(|err| err.into_inner());
                db.delete_meeting(id)
            })
            .await;
            return Err(e);
        }
    };

    *active = Some(ActiveMeeting {
        meeting_id: id,
        capture,
        worker,
    });
    state.active.store(true, Ordering::Release);
    state.meeting_id.store(id, Ordering::Release);
    state.started_at.store(started_at, Ordering::Release);
    info!(meeting_id = id, "meeting recording started");
    Ok(id)
}

async fn stop(
    db: &Arc<Mutex<Database>>,
    config: &Arc<AppConfig>,
    state: &Arc<MeetingState>,
    active: &mut Option<ActiveMeeting>,
) -> Result<(), String> {
    let meeting = active.take().ok_or("no meeting is being recorded")?;
    let meeting_id = meeting.meeting_id;
    let ended_at = now_unix();

    // Stopping capture closes the window channel, ending the worker; join it to
    // recover the session, then finalize. All blocking.
    let finalize = tokio::task::spawn_blocking(move || -> Result<(), String> {
        meeting.capture.stop();
        let session = meeting
            .worker
            .join()
            .map_err(|_| "meeting worker thread panicked".to_string())?;
        session.finalize(ended_at).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    state.active.store(false, Ordering::Release);
    state.meeting_id.store(0, Ordering::Release);
    state.started_at.store(0, Ordering::Release);
    finalize?;

    // Best-effort: embeddings + summary. Does not affect stop success.
    postprocess::run(db.clone(), config.clone(), meeting_id).await;
    info!(meeting_id, "meeting recording stopped");
    Ok(())
}
