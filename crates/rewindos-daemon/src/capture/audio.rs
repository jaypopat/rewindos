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
}
