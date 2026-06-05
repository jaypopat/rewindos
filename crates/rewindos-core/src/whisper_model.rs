//! Whisper.cpp GGUF model download from the canonical HuggingFace repo.

use std::path::PathBuf;

use crate::config::AppConfig;
use crate::error::{CoreError, Result};

/// Canonical HuggingFace URL for a whisper.cpp ggml model (e.g. "base.en").
pub fn whisper_model_url(model: &str) -> String {
    format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin")
}

/// Download the configured whisper model into `model_dir` if not already present.
/// Returns the final model path. Streams to a `.part` temp file then renames, so a
/// partial download never looks complete. 30-minute timeout (models range from
/// ~75 MB `base` to ~1.5 GB `large`).
pub async fn ensure_model_downloaded(config: &AppConfig) -> Result<PathBuf> {
    let dest = config.whisper_model_path()?;
    if dest.exists() {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CoreError::Config(format!("create model dir: {e}")))?;
    }

    let url = whisper_model_url(&config.meeting.model);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| CoreError::Embedding(format!("http client: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| CoreError::Embedding(format!("download request: {e}")))?;
    if !resp.status().is_success() {
        return Err(CoreError::Embedding(format!(
            "model download failed: HTTP {} for {url}",
            resp.status()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| CoreError::Embedding(format!("download body: {e}")))?;

    let tmp = dest.with_extension("part");
    std::fs::write(&tmp, &bytes)
        .map_err(|e| CoreError::Config(format!("write model: {e}")))?;
    std::fs::rename(&tmp, &dest)
        .map_err(|e| CoreError::Config(format!("finalize model: {e}")))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_uses_ggml_prefix_and_model_name() {
        assert_eq!(
            whisper_model_url("base.en"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
        );
        assert_eq!(
            whisper_model_url("small"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }
}
