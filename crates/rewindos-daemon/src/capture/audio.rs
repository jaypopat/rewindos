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

/// 20 ms analysis frame at the capture rate.
const FRAME: usize = CAPTURE_RATE as usize / 50;

/// Splits an f32 sample stream into windows at silence boundaries, with a hard
/// cap and a tail flush. Energy-gate VAD: a window flushes once it contains
/// voiced audio, has reached the minimum length, and then sees enough
/// consecutive silent frames — or unconditionally at the cap.
pub struct Windower {
    source: AudioSource,
    buf: Vec<f32>,
    /// Whole 20 ms frames of `buf` already analyzed.
    frames_processed: usize,
    /// Consecutive silent frames at the analysis head.
    silent_run: usize,
    /// Any voiced frame seen in the current (un-emitted) window.
    voiced: bool,
    /// Sample offset of the current window's start, from capture start.
    window_start_sample: u64,
    min_window: usize,
    max_window: usize,
    silence_threshold: f32,
    silence_run_needed: usize,
}

impl Windower {
    pub fn new(source: AudioSource) -> Self {
        Self {
            source,
            buf: Vec::new(),
            frames_processed: 0,
            silent_run: 0,
            voiced: false,
            window_start_sample: 0,
            min_window: CAPTURE_RATE as usize * 2,   // 2 s before a silence-flush
            max_window: CAPTURE_RATE as usize * 30,  // hard 30 s cap
            silence_threshold: 0.01,                 // RMS below = silent
            silence_run_needed: 25,                  // ~0.5 s of silence (25×20 ms)
        }
    }

    /// Feed captured samples; push any completed windows into `out`.
    pub fn push(&mut self, samples: &[f32], out: &mut Vec<AudioWindow>) {
        self.buf.extend_from_slice(samples);
        while (self.frames_processed + 1) * FRAME <= self.buf.len() {
            let start = self.frames_processed * FRAME;
            let level = rms(&self.buf[start..start + FRAME]);
            if level < self.silence_threshold {
                self.silent_run += 1;
            } else {
                self.silent_run = 0;
                self.voiced = true;
            }
            self.frames_processed += 1;

            let window_len = self.frames_processed * FRAME;
            let silence_flush = self.voiced
                && window_len >= self.min_window
                && self.silent_run >= self.silence_run_needed;
            let cap_flush = window_len >= self.max_window;
            if silence_flush || cap_flush {
                self.emit(window_len, out);
            }
        }
    }

    /// Emit whatever remains (call on stop / tail flush).
    pub fn flush(&mut self, out: &mut Vec<AudioWindow>) {
        if !self.buf.is_empty() {
            let cut = self.buf.len();
            self.emit(cut, out);
        }
    }

    /// Emit `buf[..cut]` as a window, keeping the remainder for the next window.
    fn emit(&mut self, cut: usize, out: &mut Vec<AudioWindow>) {
        let remainder = self.buf.split_off(cut);
        let emitted = std::mem::replace(&mut self.buf, remainder);
        let len = emitted.len() as u64;
        out.push(AudioWindow {
            source: self.source,
            start_sample: self.window_start_sample,
            samples: emitted,
        });
        self.window_start_sample += len;
        self.frames_processed = 0;
        self.silent_run = 0;
        self.voiced = false;
    }
}

fn rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = frame.iter().map(|s| s * s).sum();
    (sum_sq / frame.len() as f32).sqrt()
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

    fn loud(secs: f32) -> Vec<f32> {
        vec![0.5f32; (CAPTURE_RATE as f32 * secs) as usize]
    }
    fn silent(secs: f32) -> Vec<f32> {
        vec![0.0f32; (CAPTURE_RATE as f32 * secs) as usize]
    }

    #[test]
    fn splits_window_at_silence_boundary() {
        let mut w = Windower::new(AudioSource::Mic);
        let mut out = Vec::new();
        w.push(&loud(3.0), &mut out);
        w.push(&silent(1.0), &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, AudioSource::Mic);
        assert_eq!(out[0].start_sample, 0);
        let n = out[0].samples.len();
        // ~3s speech + ~0.5s trailing silence before the flush fires.
        assert!(n >= CAPTURE_RATE as usize * 3, "n={n}");
        assert!(n <= CAPTURE_RATE as usize * 4, "n={n}");
    }

    #[test]
    fn caps_long_continuous_audio_at_30s() {
        let mut w = Windower::new(AudioSource::System);
        let mut out = Vec::new();
        w.push(&loud(31.0), &mut out); // no silence at all
        assert_eq!(out.len(), 1);
        let n = out[0].samples.len();
        assert_eq!(n, CAPTURE_RATE as usize * 30); // hard cap
    }

    #[test]
    fn tail_flush_emits_short_remainder() {
        let mut w = Windower::new(AudioSource::Mic);
        let mut out = Vec::new();
        w.push(&loud(1.0), &mut out); // below the 2s min-window
        assert!(out.is_empty());
        w.flush(&mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].samples.len(), CAPTURE_RATE as usize);
    }

    #[test]
    fn start_sample_advances_across_windows() {
        let mut w = Windower::new(AudioSource::Mic);
        let mut out = Vec::new();
        w.push(&loud(3.0), &mut out);
        w.push(&silent(1.0), &mut out);
        w.push(&loud(3.0), &mut out);
        w.push(&silent(1.0), &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1].start_sample, out[0].samples.len() as u64);
    }
}
