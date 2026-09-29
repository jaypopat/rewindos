use reqwest::blocking::Client;
use reqwest::Url;
use rewindos_core::config::MeetingConfig;
use rewindos_core::schema::NewTranscriptSegment;
use serde::Deserialize;
use std::time::Duration;

use crate::capture::audio::AudioSource;
use crate::meeting::encode::pcm_to_wav;
use crate::meeting::whisper::TranscribeError;

#[derive(Clone, Copy)]
pub enum RemoteProfile {
    OpenAi,
    WhisperCpp,
}

pub struct RemoteTranscriber {
    client: Client,
    url: String,
    model: String,
    api_key: String,
    profile: RemoteProfile,
}

#[derive(Deserialize)]
struct Response {
    text: String,
}

pub fn normalize_url(base: &str, profile: RemoteProfile) -> String {
    let Ok(mut url) = Url::parse(base) else {
        return base.trim_end_matches('/').to_string();
    };
    let path = url.path().trim_end_matches('/');
    let path = match profile {
        RemoteProfile::OpenAi if path.ends_with("/v1/audio/transcriptions") => path.to_string(),
        RemoteProfile::OpenAi if path.ends_with("/v1") => format!("{path}/audio/transcriptions"),
        RemoteProfile::OpenAi => format!("{path}/v1/audio/transcriptions"),
        RemoteProfile::WhisperCpp if path.ends_with("/inference") => path.to_string(),
        RemoteProfile::WhisperCpp => format!("{path}/inference"),
    };
    url.set_path(&path);
    url.to_string()
}

impl RemoteTranscriber {
    pub fn new(config: &MeetingConfig, profile: RemoteProfile) -> Result<Self, TranscribeError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(config.service_timeout_secs))
            .build()
            .map_err(|e| TranscribeError::Remote(e.to_string()))?;
        Ok(Self {
            client,
            url: normalize_url(&config.service_url, profile),
            model: config.service_model.clone(),
            api_key: config.service_api_key.clone(),
            profile,
        })
    }

    pub fn transcribe_window(
        &self,
        pcm: &[f32],
        source: AudioSource,
        start_ms: i64,
    ) -> Result<Vec<NewTranscriptSegment>, TranscribeError> {
        let mut form = reqwest::blocking::multipart::Form::new()
            .part(
                "file",
                reqwest::blocking::multipart::Part::bytes(pcm_to_wav(pcm))
                    .file_name("audio.wav")
                    .mime_str("audio/wav")
                    .map_err(|e| TranscribeError::Remote(e.to_string()))?,
            )
            .text("response_format", "json");
        if matches!(self.profile, RemoteProfile::OpenAi) {
            form = form.text("model", self.model.clone());
        }
        // Match local whisper's language inference: English-only models are forced to en;
        // multilingual models leave language detection to the service.
        if self.model.ends_with(".en") {
            form = form.text("language", "en");
        }
        let mut request = self.client.post(&self.url).multipart(form);
        if matches!(self.profile, RemoteProfile::OpenAi) && !self.api_key.is_empty() {
            request = request.bearer_auth(&self.api_key);
        }
        let response = request
            .send()
            .map_err(|e| TranscribeError::Remote(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            const MAX_ERROR_BODY: usize = 8 * 1024;
            let body = response.text().unwrap_or_default();
            return Err(TranscribeError::RemoteStatus(
                status.as_u16(),
                body.chars().take(MAX_ERROR_BODY).collect(),
            ));
        }
        let text: Response = response
            .json()
            .map_err(|e| TranscribeError::Remote(e.to_string()))?;
        if text.text.trim().is_empty() {
            return Ok(Vec::new());
        }
        Ok(vec![NewTranscriptSegment {
            start_ms,
            end_ms: start_ms + (pcm.len() as i64 * 1000 / 16_000),
            source: source.as_str().to_string(),
            speaker_label: source.speaker_label().to_string(),
            text: text.text.trim().to_string(),
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn request_server(
        status: &str,
        body: &str,
        expected_auth: Option<&str>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_string();
        let body = body.to_string();
        let expected_auth = expected_auth.map(str::to_string);
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            let mut content_length: Option<usize> = None;
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if content_length.is_none() {
                    if let Some(headers_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                        content_length = headers.lines().find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")?
                                .trim()
                                .parse()
                                .ok()
                        });
                    }
                }
                if let Some(length) = content_length {
                    if let Some(headers_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        if bytes.len() >= headers_end + 4 + length {
                            break;
                        }
                    }
                }
            }
            let request = String::from_utf8_lossy(&bytes);
            assert!(request.contains("multipart/form-data"));
            assert!(request.contains("name=\"file\""));
            assert!(request.contains("name=\"response_format\""));
            assert!(request.contains("RIFF"));
            match expected_auth {
                Some(value) => assert!(request.lines().any(|line| {
                    line.to_ascii_lowercase()
                        == format!("authorization: bearer {value}").to_ascii_lowercase()
                })),
                None => assert!(!request.to_ascii_lowercase().contains("authorization:")),
            }
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).unwrap();
        });
        (address, handle)
    }

    fn config(url: String, key: &str) -> MeetingConfig {
        MeetingConfig {
            service_url: url,
            service_api_key: key.to_string(),
            service_timeout_secs: 5,
            ..MeetingConfig::default()
        }
    }

    #[test]
    fn normalizes_openai_root_version_and_full_urls() {
        assert_eq!(
            normalize_url("http://host:8000", RemoteProfile::OpenAi),
            "http://host:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_url("http://host:8000/v1", RemoteProfile::OpenAi),
            "http://host:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            normalize_url(
                "http://host:8000/v1/audio/transcriptions",
                RemoteProfile::OpenAi
            ),
            "http://host:8000/v1/audio/transcriptions"
        );
    }

    #[test]
    fn normalizes_native_root_and_full_urls() {
        assert_eq!(
            normalize_url("http://host:8000", RemoteProfile::WhisperCpp),
            "http://host:8000/inference"
        );
        assert_eq!(
            normalize_url("http://host:8000/inference", RemoteProfile::WhisperCpp),
            "http://host:8000/inference"
        );
    }

    #[test]
    fn normalization_preserves_query_and_fragment() {
        assert_eq!(
            normalize_url("http://host:8000?token=x#part", RemoteProfile::OpenAi),
            "http://host:8000/v1/audio/transcriptions?token=x#part"
        );
        assert_eq!(
            normalize_url(
                "http://host:8000/inference?token=x#part",
                RemoteProfile::WhisperCpp
            ),
            "http://host:8000/inference?token=x#part"
        );
    }

    #[test]
    fn wav_payload_has_pcm_header_and_expected_length() {
        let wav = pcm_to_wav(&[0.0, 1.0, -1.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 6);
        assert_eq!(wav.len(), 50);
    }

    #[test]
    fn sends_multipart_auth_and_parses_response() {
        let (url, server) = request_server("200 OK", r#"{"text":" hello "}"#, Some("secret"));
        let transcriber =
            RemoteTranscriber::new(&config(url, "secret"), RemoteProfile::OpenAi).unwrap();
        let result = transcriber
            .transcribe_window(&[0.0; 160], AudioSource::System, 1000)
            .unwrap();
        assert_eq!(result[0].text, "hello");
        assert_eq!(result[0].source, "system");
        assert_eq!(result[0].speaker_label, "Remote");
        server.join().unwrap();
    }

    #[test]
    fn sends_no_auth_when_key_is_empty() {
        let (url, server) = request_server("200 OK", r#"{"text":"ok"}"#, None);
        let transcriber =
            RemoteTranscriber::new(&config(url, ""), RemoteProfile::WhisperCpp).unwrap();
        assert_eq!(
            transcriber
                .transcribe_window(&[0.0; 1], AudioSource::Mic, 0)
                .unwrap()[0]
                .text,
            "ok"
        );
        server.join().unwrap();
    }

    #[test]
    fn whisper_cpp_sends_no_auth_even_when_key_is_configured() {
        let (url, server) = request_server("200 OK", r#"{"text":"ok"}"#, None);
        let transcriber =
            RemoteTranscriber::new(&config(url, "must-not-leak"), RemoteProfile::WhisperCpp)
                .unwrap();
        assert_eq!(
            transcriber
                .transcribe_window(&[0.0; 1], AudioSource::Mic, 0)
                .unwrap()[0]
                .text,
            "ok"
        );
        server.join().unwrap();
    }

    #[test]
    fn caps_remote_error_body() {
        let body = "x".repeat(20_000);
        let (url, server) = request_server("500 Internal Server Error", &body, None);
        let transcriber = RemoteTranscriber::new(&config(url, ""), RemoteProfile::OpenAi).unwrap();
        let Err(TranscribeError::RemoteStatus(_, message)) =
            transcriber.transcribe_window(&[0.0], AudioSource::Mic, 0)
        else {
            panic!("expected remote status error");
        };
        assert_eq!(message.len(), 8 * 1024);
        server.join().unwrap();
    }

    #[test]
    fn surfaces_status_and_malformed_responses() {
        let (url, server) =
            request_server("500 Internal Server Error", r#"{"error":"nope"}"#, None);
        let transcriber = RemoteTranscriber::new(&config(url, ""), RemoteProfile::OpenAi).unwrap();
        assert!(matches!(
            transcriber.transcribe_window(&[0.0], AudioSource::Mic, 0),
            Err(TranscribeError::RemoteStatus(500, _))
        ));
        server.join().unwrap();

        let (url, server) = request_server("200 OK", r#"{"result":"missing text"}"#, None);
        let transcriber = RemoteTranscriber::new(&config(url, ""), RemoteProfile::OpenAi).unwrap();
        assert!(matches!(
            transcriber.transcribe_window(&[0.0], AudioSource::Mic, 0),
            Err(TranscribeError::Remote(_))
        ));
        server.join().unwrap();
    }
}
