//! Local speech-to-text for meeting audio via the `whisper-rs` crate, which
//! vendors and compiles whisper.cpp at build time (in-process FFI — no binary
//! to ship or detect on PATH; only the GGUF model file can be missing at run
//! time). Input is mono f32 16 kHz PCM, exactly what `capture::audio` delivers.

use std::path::PathBuf;

use rewindos_core::config::AppConfig;

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

#[cfg(test)]
mod tests {
    use super::*;

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
