//! Meeting audio capture: two PipeWire input streams (mic + sink monitor),
//! VAD-windowed into f32 PCM windows. See `src/bin/audio_spike.rs` for the
//! proven pipewire wiring this builds on.

/// Sample rate captured for transcription (whisper's native input).
pub const CAPTURE_RATE: u32 = 16_000;

/// Which audio source a stream captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioSource {
    /// Default microphone (PipeWire default source).
    Mic,
    /// Default sink monitor (system output).
    System,
}

impl AudioSource {
    /// Storage value for `transcript_segments.source`.
    pub fn as_str(self) -> &'static str {
        match self {
            AudioSource::Mic => "mic",
            AudioSource::System => "system",
        }
    }

    /// Display label for `transcript_segments.speaker_label`.
    pub fn speaker_label(self) -> &'static str {
        match self {
            AudioSource::Mic => "You",
            AudioSource::System => "Remote",
        }
    }
}

/// A completed PCM window, ready for encode + transcription.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioWindow {
    pub source: AudioSource,
    /// Sample offset of this window's start, relative to capture start.
    pub start_sample: u64,
    /// Mono f32 samples at `CAPTURE_RATE`.
    pub samples: Vec<f32>,
}

/// Convert interleaved S16_LE bytes to normalized f32 samples in [-1.0, 1.0].
/// A trailing odd byte (incomplete sample) is ignored. The spike confirmed
/// PipeWire negotiates S16_LE here; this is the capture→f32 boundary.
pub fn s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_maps_to_storage_and_label() {
        assert_eq!(AudioSource::Mic.as_str(), "mic");
        assert_eq!(AudioSource::Mic.speaker_label(), "You");
        assert_eq!(AudioSource::System.as_str(), "system");
        assert_eq!(AudioSource::System.speaker_label(), "Remote");
    }

    #[test]
    fn s16le_to_f32_normalizes_and_ignores_odd_tail() {
        // 0, i16::MAX, i16::MIN, then a dangling odd byte that must be ignored.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0i16.to_le_bytes());
        bytes.extend_from_slice(&i16::MAX.to_le_bytes());
        bytes.extend_from_slice(&i16::MIN.to_le_bytes());
        bytes.push(0x7f); // dangling
        let out = s16le_to_f32(&bytes);
        assert_eq!(out.len(), 3);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 0.99997).abs() < 1e-3); // 32767/32768
        assert!((out[2] + 1.0).abs() < 1e-6); // -32768/32768 = -1.0
    }
}
