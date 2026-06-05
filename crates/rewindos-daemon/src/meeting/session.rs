//! Per-meeting processing: consume captured PCM windows, optionally encode them
//! to Ogg-Opus (gated by `keep_audio`), transcribe them, and index the segments.
//! Decoupled from the live capture source (and from whisper, via `Transcribe`)
//! so the whole flow is unit-testable with synthetic windows and a fake model.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rewindos_core::db::Database;
use rewindos_core::schema::NewTranscriptSegment;

use crate::capture::audio::{AudioSource, AudioWindow, CAPTURE_RATE};
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

    /// Process one captured window: encode it (if `keep_audio`), transcribe it,
    /// and insert the resulting segments. Errors are returned so the caller can
    /// log-and-continue per window.
    pub fn process_window(&mut self, window: &AudioWindow) -> Result<(), SessionError> {
        if let Some(writer) = self.writer_for(window.source) {
            writer.push(&window.samples)?;
        }
        let window_start_ms = (window.start_sample * 1000 / CAPTURE_RATE as u64) as i64;
        let segments =
            self.transcriber
                .transcribe_window(&window.samples, window.source, window_start_ms)?;
        if segments.is_empty() {
            return Ok(());
        }
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        for seg in &segments {
            db.insert_transcript_segment(self.meeting_id, seg)?;
        }
        Ok(())
    }

    /// Finish the meeting: flush both writers to disk, then record the end time
    /// and (only when `keep_audio`) the audio paths. Consumes the session.
    pub fn finalize(self, ended_at: i64) -> Result<(), SessionError> {
        if let Some(writer) = self.mic_writer {
            writer.finalize()?;
        }
        if let Some(writer) = self.sys_writer {
            writer.finalize()?;
        }
        let (mic, sys) = if self.keep_audio {
            (
                self.mic_path.to_str().map(str::to_string),
                self.sys_path.to_str().map(str::to_string),
            )
        } else {
            (None, None)
        };
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        db.end_meeting(self.meeting_id, ended_at, mic.as_deref(), sys.as_deref())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic transcriber: one segment per window, text fixed, timing
    /// derived from the window so tests can assert the offset shift.
    struct FakeTranscriber;
    impl Transcribe for FakeTranscriber {
        fn transcribe_window(
            &self,
            _pcm: &[f32],
            source: AudioSource,
            window_start_ms: i64,
        ) -> Result<Vec<NewTranscriptSegment>, TranscribeError> {
            Ok(vec![NewTranscriptSegment {
                start_ms: window_start_ms,
                end_ms: window_start_ms + 1000,
                source: source.as_str().to_string(),
                speaker_label: source.speaker_label().to_string(),
                text: "hello world".to_string(),
            }])
        }
    }

    fn temp_db() -> (tempfile::TempDir, Arc<Mutex<Database>>) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        (dir, Arc::new(Mutex::new(db)))
    }

    #[test]
    fn process_window_without_keep_audio_inserts_segments_and_writes_no_files() {
        let (dir, db) = temp_db();
        let meeting_id = {
            let g = db.lock().unwrap();
            g.insert_meeting(1_000, Some("Test"), None).unwrap()
        };
        let mic_path = dir.path().join("m.opus");
        let sys_path = dir.path().join("s.opus");
        let mut session = MeetingSession::new(
            meeting_id,
            db.clone(),
            Arc::new(FakeTranscriber),
            false, // keep_audio off
            mic_path.clone(),
            sys_path.clone(),
        )
        .unwrap();

        // mic window at sample 0 (0 ms), system window at sample 16000 (1000 ms).
        session
            .process_window(&AudioWindow {
                source: AudioSource::Mic,
                start_sample: 0,
                samples: vec![0.1; 320],
            })
            .unwrap();
        session
            .process_window(&AudioWindow {
                source: AudioSource::System,
                start_sample: CAPTURE_RATE as u64,
                samples: vec![0.1; 320],
            })
            .unwrap();

        let segs = db.lock().unwrap().get_meeting_segments(meeting_id).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].speaker_label, "You");
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[1].speaker_label, "Remote");
        assert_eq!(segs[1].start_ms, 1000);
        assert!(!mic_path.exists(), "no audio file when keep_audio is off");
        assert!(!sys_path.exists());
    }

    #[test]
    fn keep_audio_writes_decodable_files_and_records_paths_and_fts() {
        let (dir, db) = temp_db();
        let meeting_id = {
            let g = db.lock().unwrap();
            g.insert_meeting(2_000, Some("Recorded"), None).unwrap()
        };
        let mic_path = dir.path().join("rec-mic.opus");
        let sys_path = dir.path().join("rec-system.opus");
        let mut session = MeetingSession::new(
            meeting_id,
            db.clone(),
            Arc::new(FakeTranscriber),
            true, // keep_audio on
            mic_path.clone(),
            sys_path.clone(),
        )
        .unwrap();

        // One full 20 ms frame per source so the encoder emits a packet.
        session
            .process_window(&AudioWindow {
                source: AudioSource::Mic,
                start_sample: 0,
                samples: vec![0.05; 320],
            })
            .unwrap();
        session
            .process_window(&AudioWindow {
                source: AudioSource::System,
                start_sample: CAPTURE_RATE as u64,
                samples: vec![0.05; 320],
            })
            .unwrap();
        session.finalize(5_000).unwrap();

        // Audio files exist and are non-trivial.
        assert!(mic_path.exists());
        assert!(sys_path.exists());
        assert!(std::fs::metadata(&mic_path).unwrap().len() > 0);

        // Meeting row finalized with paths + end time.
        let meetings = db.lock().unwrap().list_meetings(10, 0).unwrap();
        let m = meetings.iter().find(|m| m.id == meeting_id).unwrap();
        assert_eq!(m.ended_at, Some(5_000));
        assert_eq!(m.mic_audio_path.as_deref(), mic_path.to_str());
        assert_eq!(m.system_audio_path.as_deref(), sys_path.to_str());

        // FTS finds the transcript text.
        let hits = db
            .lock()
            .unwrap()
            .search_transcripts("hello", None, 10)
            .unwrap();
        assert!(hits.iter().any(|h| h.meeting_id == meeting_id));
    }
}
