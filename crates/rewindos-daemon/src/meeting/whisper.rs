//! Local speech-to-text for meeting audio via the `whisper-rs` crate, which
//! vendors and compiles whisper.cpp at build time (in-process FFI — no binary
//! to ship or detect on PATH; only the GGUF model file can be missing at run
//! time). Input is mono f32 16 kHz PCM, exactly what `capture::audio` delivers.

use std::path::PathBuf;

use rewindos_core::config::AppConfig;
use rewindos_core::schema::NewTranscriptSegment;

use crate::capture::audio::AudioSource;

/// Errors from model loading or transcription.
#[derive(Debug, thiserror::Error)]
pub enum TranscribeError {
    #[error(
        "whisper model not found at {0} (download a GGUF model such as \
         ggml-base.en.bin into the configured whisper model directory)"
    )]
    ModelNotFound(PathBuf),
    #[error("config error: {0}")]
    Config(String),
    #[error("whisper error: {0}")]
    Whisper(#[from] whisper_rs::WhisperError),
}

/// Resolve the configured whisper model path and confirm the GGUF file exists.
/// Called at `StartMeeting` so we can refuse with an actionable error instead
/// of failing mid-capture. The library is compiled in, so the model file is the
/// only thing that can be missing.
pub fn ensure_model_available(config: &AppConfig) -> Result<PathBuf, TranscribeError> {
    let path = config
        .whisper_model_path()
        .map_err(|e| TranscribeError::Config(e.to_string()))?;
    if path.exists() {
        Ok(path)
    } else {
        Err(TranscribeError::ModelNotFound(path))
    }
}

/// Convert one whisper segment into a storable transcript segment.
///
/// whisper.cpp reports timestamps in **centiseconds** relative to the start of
/// the PCM buffer it was given; we multiply by 10 to get milliseconds and add
/// `window_start_ms` to shift into absolute meeting time. The `AudioSource`
/// supplies both the storage tag (`mic`/`system`) and the display speaker
/// label (`You`/`Remote`).
fn build_segment(
    text: &str,
    seg_start_cs: i64,
    seg_end_cs: i64,
    source: AudioSource,
    window_start_ms: i64,
) -> NewTranscriptSegment {
    NewTranscriptSegment {
        start_ms: window_start_ms + seg_start_cs * 10,
        end_ms: window_start_ms + seg_end_cs * 10,
        source: source.as_str().to_string(),
        speaker_label: source.speaker_label().to_string(),
        text: text.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_segment_shifts_centiseconds_to_absolute_ms() {
        // whisper reports 1.50s–2.30s (centiseconds) inside a window that began
        // 60_000 ms into the meeting.
        let seg = build_segment("  hello world ", 150, 230, AudioSource::Mic, 60_000);
        assert_eq!(seg.start_ms, 60_000 + 1_500);
        assert_eq!(seg.end_ms, 60_000 + 2_300);
        assert_eq!(seg.text, "hello world"); // trimmed
    }

    #[test]
    fn build_segment_maps_source_to_tag_and_label() {
        let mic = build_segment("hi", 0, 10, AudioSource::Mic, 0);
        assert_eq!(mic.source, "mic");
        assert_eq!(mic.speaker_label, "You");

        let sys = build_segment("hi", 0, 10, AudioSource::System, 0);
        assert_eq!(sys.source, "system");
        assert_eq!(sys.speaker_label, "Remote");
    }

    #[test]
    fn ensure_model_available_errors_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.meeting.model_dir = dir.path().to_str().unwrap().to_string();
        config.meeting.model = "base.en".to_string();
        let err = ensure_model_available(&config).unwrap_err();
        assert!(matches!(err, TranscribeError::ModelNotFound(_)));
    }
}
