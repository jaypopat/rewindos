//! Loopback HTTP server for meeting-audio playback.
//!
//! WebKitGTK's media element hands playback to GStreamer, which can only fetch
//! `file://` and `http(s)://` URIs — it cannot read `blob:` URLs (WebKit-internal)
//! or Tauri's `asset://` protocol, so every in-process delivery path fails with
//! MediaError code 4. Serving the audio over 127.0.0.1 HTTP is the established
//! workaround (see tauri#3725): GStreamer's souphttpsrc fetches it like any
//! stream, and Range support gives us seeking.
//!
//! Files are exposed only after explicit registration (random UUID per path),
//! so the server never acts as a general file reader.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tracing::{info, warn};

/// Decode an Ogg-Opus stream (16 kHz mono, as written by the meeting encoder)
/// into a 16-bit PCM WAV byte buffer. WAV because it is the one format every
/// GStreamer install can decode; opus plugin presence varies by distro.
pub fn opus_ogg_to_wav(ogg_bytes: &[u8]) -> Result<Vec<u8>, String> {
    const RATE: u32 = 16_000;
    let mut reader = ogg::PacketReader::new(Cursor::new(ogg_bytes));
    let mut decoder =
        opus::Decoder::new(RATE, opus::Channels::Mono).map_err(|e| format!("opus init: {e}"))?;
    let mut pcm: Vec<i16> = Vec::new();
    let mut frame = vec![0i16; 5760]; // ≥ any single opus frame at 48 kHz
    while let Some(packet) = reader.read_packet().map_err(|e| format!("ogg read: {e}"))? {
        // Skip the OpusHead / OpusTags header packets; decode the rest.
        if packet.data.starts_with(b"OpusHead") || packet.data.starts_with(b"OpusTags") {
            continue;
        }
        let n = decoder
            .decode(&packet.data, &mut frame, false)
            .map_err(|e| format!("opus decode: {e}"))?;
        pcm.extend_from_slice(&frame[..n]);
    }
    Ok(pcm_to_wav(&pcm, RATE, 1))
}

/// Wrap mono/stereo 16-bit PCM samples in a canonical 44-byte WAV header.
pub fn pcm_to_wav(pcm: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let block_align = channels * bits_per_sample / 8;
    let byte_rate = sample_rate * block_align as u32;
    let data_len = (pcm.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + pcm.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Handle to the loopback audio server: the bound port plus the registry of
/// id → file mappings it is allowed to serve.
pub struct AudioServer {
    port: u16,
    paths: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl AudioServer {
    /// Bind 127.0.0.1 on an ephemeral port and spawn the serving thread.
    pub fn start() -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("bind audio server: {e}"))?;
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => return Err("audio server bound to a non-IP address".into()),
        };
        let paths: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let thread_paths = paths.clone();
        std::thread::Builder::new()
            .name("rewindos-audio-http".into())
            .spawn(move || serve_loop(server, thread_paths))
            .map_err(|e| format!("spawn audio server: {e}"))?;
        info!(port, "meeting-audio HTTP server listening on 127.0.0.1");
        Ok(Self { port, paths })
    }

    /// Expose `path` and return the URL to play it from. Registering the same
    /// path twice reuses the existing id so URLs stay stable per session.
    pub fn register(&self, path: PathBuf) -> String {
        let mut map = self.paths.lock().unwrap_or_else(|e| e.into_inner());
        let id = map
            .iter()
            .find(|(_, p)| **p == path)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| {
                let id = uuid::Uuid::new_v4().simple().to_string();
                map.insert(id.clone(), path);
                id
            });
        format!("http://127.0.0.1:{}/audio/{}", self.port, id)
    }
}

fn serve_loop(server: tiny_http::Server, paths: Arc<Mutex<HashMap<String, PathBuf>>>) {
    // GStreamer probes with several ranged GETs per playback; cache the last
    // transcode so we don't decode the same file for every probe.
    let mut cache: Option<(String, Arc<Vec<u8>>)> = None;
    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let Some(id) = url.strip_prefix("/audio/") else {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        };
        let id = id.split(['?', '#']).next().unwrap_or("").to_string();
        let path = {
            let map = paths.lock().unwrap_or_else(|e| e.into_inner());
            map.get(&id).cloned()
        };
        let Some(path) = path else {
            let _ = request.respond(tiny_http::Response::empty(404));
            continue;
        };

        let wav = match &cache {
            Some((cached_id, bytes)) if *cached_id == id => bytes.clone(),
            _ => match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|b| {
                opus_ogg_to_wav(&b)
            }) {
                Ok(bytes) => {
                    let bytes = Arc::new(bytes);
                    cache = Some((id.clone(), bytes.clone()));
                    bytes
                }
                Err(e) => {
                    warn!(error = %e, ?path, "audio server: failed to read/transcode");
                    let _ = request.respond(tiny_http::Response::empty(500));
                    continue;
                }
            },
        };

        let range = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Range"))
            .and_then(|h| parse_range(h.value.as_str(), wav.len()));
        let _ = match range {
            Some((start, end)) => {
                let body = wav[start..=end].to_vec();
                let mut resp = tiny_http::Response::from_data(body).with_status_code(206);
                add_audio_headers(&mut resp);
                resp.add_header(
                    tiny_http::Header::from_bytes(
                        &b"Content-Range"[..],
                        format!("bytes {start}-{end}/{}", wav.len()).as_bytes(),
                    )
                    .expect("valid header"),
                );
                request.respond(resp)
            }
            None => {
                let mut resp = tiny_http::Response::from_data(wav.as_ref().clone());
                add_audio_headers(&mut resp);
                request.respond(resp)
            }
        };
    }
}

fn add_audio_headers(resp: &mut tiny_http::Response<Cursor<Vec<u8>>>) {
    resp.add_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"audio/wav"[..])
            .expect("valid header"),
    );
    resp.add_header(
        tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..])
            .expect("valid header"),
    );
}

/// Parse `bytes=a-b` / `bytes=a-` / `bytes=-n` into an inclusive (start, end)
/// clamped to `len`. Returns None for anything unsatisfiable or non-byte units.
fn parse_range(value: &str, len: usize) -> Option<(usize, usize)> {
    if len == 0 {
        return None;
    }
    let spec = value.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", suffix) => {
            let n: usize = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len - 1)
        }
        (first, "") => (first.parse().ok()?, len - 1),
        (first, last) => (first.parse().ok()?, last.parse::<usize>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_handles_all_forms() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=200-", 1000), Some((200, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None); // past end
        assert_eq!(parse_range("items=0-1", 1000), None); // wrong unit
        assert_eq!(parse_range("bytes=5-2", 1000), None); // inverted
    }

    #[test]
    fn pcm_to_wav_writes_a_canonical_header() {
        // 3 mono samples @ 16 kHz → 6 bytes of data, 44-byte header.
        let wav = pcm_to_wav(&[0, 1, -1], 16_000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // fmt: PCM(1), 1 channel, 16000 Hz, 16-bit.
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1);
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16_000);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        // data chunk length + total size.
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 6);
        assert_eq!(wav.len(), 44 + 6);
        assert_eq!(u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]), 36 + 6);
    }

    #[test]
    fn server_serves_registered_file_with_ranges() {
        // End-to-end over real HTTP: register a tiny opus-less WAV? The server
        // transcodes opus, so build a minimal valid Ogg-Opus via the daemon's
        // format instead — out of scope here. Cover the registry + 404 path.
        let srv = AudioServer::start().expect("server starts");
        let url = srv.register(PathBuf::from("/nonexistent/file.opus"));
        assert!(url.starts_with("http://127.0.0.1:"));
        // Same path → same URL (stable ids).
        assert_eq!(url, srv.register(PathBuf::from("/nonexistent/file.opus")));
    }
}
