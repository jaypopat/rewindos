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

/// Build the 19-byte OpusHead identification header (RFC 7845 §5.1),
/// channel mapping family 0 (mono/stereo, no mapping table).
fn opus_head(channels: u8, input_sample_rate: u32, pre_skip: u16) -> Vec<u8> {
    let mut h = Vec::with_capacity(19);
    h.extend_from_slice(b"OpusHead");
    h.push(1); // version
    h.push(channels);
    h.extend_from_slice(&pre_skip.to_le_bytes());
    h.extend_from_slice(&input_sample_rate.to_le_bytes());
    h.extend_from_slice(&0i16.to_le_bytes()); // output gain (Q7.8 dB)
    h.push(0); // channel mapping family 0
    h
}

/// Build a minimal OpusTags comment header (RFC 7845 §5.2): the given vendor
/// string and zero user comments.
fn opus_tags(vendor: &str) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(b"OpusTags");
    t.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    t.extend_from_slice(vendor.as_bytes());
    t.extend_from_slice(&0u32.to_le_bytes()); // user comment list length
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opus_head_layout_mono_16k() {
        let h = opus_head(1, 16_000, 0);
        assert_eq!(h.len(), 19);
        assert_eq!(&h[0..8], b"OpusHead");
        assert_eq!(h[8], 1, "version");
        assert_eq!(h[9], 1, "channel count");
        assert_eq!(u16::from_le_bytes([h[10], h[11]]), 0, "pre-skip");
        assert_eq!(
            u32::from_le_bytes([h[12], h[13], h[14], h[15]]),
            16_000,
            "input sample rate"
        );
        assert_eq!(i16::from_le_bytes([h[16], h[17]]), 0, "output gain");
        assert_eq!(h[18], 0, "channel mapping family");
    }

    #[test]
    fn opus_tags_has_magic_vendor_and_zero_comments() {
        let t = opus_tags("rewindos");
        assert_eq!(&t[0..8], b"OpusTags");
        let vlen = u32::from_le_bytes([t[8], t[9], t[10], t[11]]) as usize;
        assert_eq!(vlen, "rewindos".len());
        assert_eq!(&t[12..12 + vlen], b"rewindos");
        let count = u32::from_le_bytes([
            t[12 + vlen],
            t[13 + vlen],
            t[14 + vlen],
            t[15 + vlen],
        ]);
        assert_eq!(count, 0, "user comment count");
    }
}
