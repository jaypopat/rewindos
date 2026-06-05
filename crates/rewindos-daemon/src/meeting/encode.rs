//! Ogg-Opus encoding for meeting audio.
//!
//! Encodes mono f32 16 kHz PCM (as produced by `capture::audio::AudioWindow`)
//! into a standards-compliant `.opus` file. Uses the `opus` crate (bundles and
//! compiles libopus at build time via cmake — no system libopus) and the pure-
//! Rust `ogg` crate for the container. See RFC 7845 for the Ogg-Opus mapping.

use std::io::Write;

/// Capture/encode sample rate (whisper's native input; matches `AudioWindow`).
const SAMPLE_RATE: u32 = 16_000;
/// 20 ms frame at 16 kHz — the Opus frame size we encode.
const FRAME_SAMPLES: usize = 320;
/// Granule units per 20 ms frame. Ogg-Opus granule is always at 48 kHz, so
/// 20 ms = 960, regardless of the 16 kHz capture rate.
const GRANULE_PER_FRAME: u64 = 960;
/// Pre-skip (48 kHz samples) declared in OpusHead. We prepend no priming
/// samples, so this is 0 — a non-zero value would make decoders trim real
/// audio off the front of the recording.
const PRE_SKIP: u16 = 0;
/// Logical-stream serial. Each file is its own physical stream, so a fixed
/// value is fine. ASCII "RWOS".
const SERIAL: u32 = 0x5257_4F53;
/// Safe upper bound on a single Opus packet (libopus convention).
const MAX_PACKET: usize = 4000;

/// Errors from Opus encoding or Ogg writing.
#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("opus error: {0}")]
    Opus(#[from] opus::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
