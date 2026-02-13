use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

pub struct OllamaClient {
    base_url: String,
    model: String,
    client: reqwest::Client,
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    prompt: &'a str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}

impl OllamaClient {
    pub fn new(base_url: &str, model: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Generate an embedding for the given text.
    /// Returns `None` if Ollama is unavailable (graceful degradation).
    pub async fn embed(&self, text: &str) -> Result<Option<Vec<f32>>> {
        let url = format!("{}/api/embeddings", self.base_url);
        let req = EmbeddingRequest {
            model: &self.model,
            prompt: text,
        };

        let response = match self.client.post(&url).json(&req).send().await {
            Ok(r) => r,
            Err(e) if e.is_connect() || e.is_timeout() => return Ok(None),
            Err(e) => return Err(CoreError::Embedding(format!("request failed: {e}"))),
        };

        if !response.status().is_success() {
            return Err(CoreError::Embedding(format!(
                "ollama returned status {}",
                response.status()
            )));
        }

        let body: EmbeddingResponse = response
            .json()
            .await
            .map_err(|e| CoreError::Embedding(format!("parse response: {e}")))?;

        Ok(Some(body.embedding))
    }

    /// Check if Ollama is reachable.
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/api/tags", self.base_url);
        matches!(self.client.get(&url).send().await, Ok(r) if r.status().is_success())
    }
}
