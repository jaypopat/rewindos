//! Local speech-to-text for meeting audio via the `whisper-rs` crate, which
//! vendors and compiles whisper.cpp at build time (in-process FFI — no binary
//! to ship or detect on PATH; only the GGUF model file can be missing at run
//! time). Input is mono f32 16 kHz PCM, exactly what `capture::audio` delivers.

use std::path::{Path, PathBuf};

use rewindos_core::config::AppConfig;
use rewindos_core::schema::NewTranscriptSegment;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

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

/// Pick whisper's language setting from the model filename. whisper.cpp `*.en`
/// models are English-only (use `"en"`); multilingual models use `"auto"` so the
/// spoken language is detected rather than forced to English.
fn language_for_model(model_path: &Path) -> &'static str {
    let is_english_only = model_path
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.ends_with(".en"));
    if is_english_only {
        "en"
    } else {
        "auto"
    }
}

/// A loaded whisper model ready to transcribe PCM windows. The underlying
/// `WhisperContext` is `Send + Sync`; a fresh inference state is created per
/// call, so `transcribe_window` takes `&self` and the transcriber can be shared
/// via `Arc` once a later milestone wires it into the pipeline.
pub struct WhisperTranscriber {
    ctx: WhisperContext,
    n_threads: i32,
    language: &'static str,
}

impl WhisperTranscriber {
    /// Load a GGUF model from `model_path` (CPU-only — no GPU features enabled).
    pub fn load(model_path: &Path, n_threads: i32) -> Result<Self, TranscribeError> {
        let language = language_for_model(model_path);
        let ctx =
            WhisperContext::new_with_params(model_path, WhisperContextParameters::default())?;
        Ok(Self {
            ctx,
            n_threads,
            language,
        })
    }

    /// Transcribe one mono f32 16 kHz PCM window into absolute-timed segments.
    /// `window_start_ms` is the window's offset from the start of the meeting.
    /// Blank segments are dropped.
    pub fn transcribe_window(
        &self,
        pcm: &[f32],
        source: AudioSource,
        window_start_ms: i64,
    ) -> Result<Vec<NewTranscriptSegment>, TranscribeError> {
        let mut state = self.ctx.create_state()?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(self.n_threads);
        params.set_translate(false);
        params.set_language(Some(self.language));
        // Keep whisper.cpp from writing progress/segment chatter to stdout.
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        state.full(params, pcm)?;

        let mut segments = Vec::new();
        for seg in state.as_iter() {
            let text = seg.to_str_lossy()?;
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            segments.push(build_segment(
                trimmed,
                seg.start_timestamp(),
                seg.end_timestamp(),
                source,
                window_start_ms,
            ));
        }
        Ok(segments)
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
    fn language_for_model_detects_english_only_models() {
        assert_eq!(language_for_model(Path::new("/m/ggml-base.en.bin")), "en");
        assert_eq!(language_for_model(Path::new("/m/ggml-small.en.bin")), "en");
        assert_eq!(language_for_model(Path::new("/m/ggml-base.bin")), "auto");
        assert_eq!(language_for_model(Path::new("/m/ggml-large-v3.bin")), "auto");
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
