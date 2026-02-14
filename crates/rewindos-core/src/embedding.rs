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

#[derive(Deserialize)]
struct TagsResponse {
    models: Option<Vec<ModelTag>>,
}

#[derive(Deserialize)]
struct ModelTag {
    name: String,
}

#[derive(Serialize)]
struct PullRequest<'a> {
    name: &'a str,
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

    /// Check if a specific model is available locally in Ollama.
    pub async fn has_model(&self, model: &str) -> bool {
        let url = format!("{}/api/tags", self.base_url);
        let response = match self.client.get(&url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => return false,
        };

        let tags: TagsResponse = match response.json().await {
            Ok(t) => t,
            Err(_) => return false,
        };

        tags.models
            .unwrap_or_default()
            .iter()
            .any(|m| m.name == model || m.name.starts_with(&format!("{model}:")))
    }

    /// Pull a model from the Ollama registry. Returns `true` if the pull succeeds.
    /// Uses a 10-minute timeout since model downloads can be large.
    pub async fn pull_model(&self, model: &str) -> Result<bool> {
        let url = format!("{}/api/pull", self.base_url);
        let pull_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .unwrap_or_default();

        let response = match pull_client
            .post(&url)
            .json(&PullRequest { name: model })
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) if e.is_connect() || e.is_timeout() => return Ok(false),
            Err(e) => return Err(CoreError::Embedding(format!("pull request failed: {e}"))),
        };

        Ok(response.status().is_success())
    }

    /// Get the model name this client is configured for.
    pub fn model(&self) -> &str {
        &self.model
    }
}
