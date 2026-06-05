//! Per-meeting processing: consume captured PCM windows, optionally encode them
//! to Ogg-Opus (gated by `keep_audio`), transcribe them, and index the segments.
//! Decoupled from the live capture source (and from whisper, via `Transcribe`)
//! so the whole flow is unit-testable with synthetic windows and a fake model.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rewindos_core::db::Database;
use rewindos_core::schema::NewTranscriptSegment;

use crate::capture::audio::AudioSource;
use crate::meeting::encode::{EncodeError, OpusWriter};
use crate::meeting::whisper::{TranscribeError, WhisperTranscriber};

/// The transcription capability a session needs. Implemented by the real
/// `WhisperTranscriber` and by test fakes, so sessions need no whisper model.
pub trait Transcribe: Send + Sync {
    fn transcribe_window(
        &self,
        pcm: &[f32],
        source: AudioSource,
        window_start_ms: i64,
    ) -> Result<Vec<NewTranscriptSegment>, TranscribeError>;
}

impl Transcribe for WhisperTranscriber {
    fn transcribe_window(
        &self,
        pcm: &[f32],
        source: AudioSource,
        window_start_ms: i64,
    ) -> Result<Vec<NewTranscriptSegment>, TranscribeError> {
        WhisperTranscriber::transcribe_window(self, pcm, source, window_start_ms)
    }
}

/// Errors from running a meeting session.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("encode error: {0}")]
    Encode(#[from] EncodeError),
    #[error("transcribe error: {0}")]
    Transcribe(#[from] TranscribeError),
    #[error("db error: {0}")]
    Db(#[from] rewindos_core::CoreError),
}

type FileOpusWriter = OpusWriter<std::io::BufWriter<std::fs::File>>;

/// One in-progress meeting: writers (only when `keep_audio`), the transcriber,
/// and the DB handle. Construct, feed windows via `process_window`, then
/// `finalize`.
pub struct MeetingSession {
    meeting_id: i64,
    db: Arc<Mutex<Database>>,
    transcriber: Arc<dyn Transcribe>,
    keep_audio: bool,
    mic_writer: Option<FileOpusWriter>,
    sys_writer: Option<FileOpusWriter>,
    mic_path: PathBuf,
    sys_path: PathBuf,
}

impl MeetingSession {
    /// Create a session. When `keep_audio`, both `.opus` writers are opened now
    /// (their parent directory must already exist); otherwise no files are made.
    pub fn new(
        meeting_id: i64,
        db: Arc<Mutex<Database>>,
        transcriber: Arc<dyn Transcribe>,
        keep_audio: bool,
        mic_path: PathBuf,
        sys_path: PathBuf,
    ) -> Result<Self, SessionError> {
        let (mic_writer, sys_writer) = if keep_audio {
            (
                Some(OpusWriter::create(&mic_path)?),
                Some(OpusWriter::create(&sys_path)?),
            )
        } else {
            (None, None)
        };
        Ok(Self {
            meeting_id,
            db,
            transcriber,
            keep_audio,
            mic_writer,
            sys_writer,
            mic_path,
            sys_path,
        })
    }

    fn writer_for(&mut self, source: AudioSource) -> Option<&mut FileOpusWriter> {
        match source {
            AudioSource::Mic => self.mic_writer.as_mut(),
            AudioSource::System => self.sys_writer.as_mut(),
        }
    }
}
