//! Meeting audio capture: two `pw-cat` subprocesses (mic + sink monitor) stream
//! raw S16/16k/mono PCM on stdout, which we convert to f32 and VAD-window.
//!
//! We shell out to `pw-cat` rather than hand-rolling SPA format negotiation with
//! `pipewire-rs`: the in-process path proved fragile on analog devices (PipeWire
//! delivered 8-bit U8 buffers while reporting S16, pinning levels and feeding
//! whisper garbage). `pw-cat` is the reference capture tool and reliably
//! negotiates a converter to exactly the S16/16k/mono format we ask for.

use std::io::{ErrorKind, Read};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use pipewire as pw;

use crate::capture::CaptureError;

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

/// A selectable audio input device.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioSourceInfo {
    pub id: u32,
    /// PipeWire `node.name` — the stable id used for `target.object`.
    pub name: String,
    /// Human-readable label.
    pub description: String,
}

/// Enumerate `Audio/Source` nodes (microphones) via the PipeWire registry.
/// Pumps the loop ~300ms to collect the registry's existing globals, then returns.
pub fn list_audio_sources() -> Result<Vec<AudioSourceInfo>, CaptureError> {
    use std::cell::RefCell;
    use std::rc::Rc;

    pw::init();
    let mainloop = pw::main_loop::MainLoopBox::new(None)
        .map_err(|e| CaptureError::PipeWire(format!("enum: main loop: {e}")))?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| CaptureError::PipeWire(format!("enum: context: {e}")))?;
    let core = context
        .connect(None)
        .map_err(|e| CaptureError::PipeWire(format!("enum: connect: {e}")))?;
    let registry = core
        .get_registry()
        .map_err(|e| CaptureError::PipeWire(format!("enum: registry: {e}")))?;

    let sources: Rc<RefCell<Vec<AudioSourceInfo>>> = Rc::new(RefCell::new(Vec::new()));
    let sources_cb = sources.clone();
    let _listener = registry
        .add_listener_local()
        .global(move |global| {
            // global.props is Option<&spa::utils::dict::DictRef>; .get(key)->Option<&str>
            let Some(props) = global.props else { return };
            if props.get("media.class") != Some("Audio/Source") {
                return;
            }
            let Some(name) = props.get("node.name") else { return };
            if name.is_empty() {
                return;
            }
            let description = props
                .get("node.description")
                .or_else(|| props.get("node.nick"))
                .unwrap_or(name)
                .to_string();
            sources_cb.borrow_mut().push(AudioSourceInfo {
                id: global.id,
                name: name.to_string(),
                description,
            });
        })
        .register();

    // Registry globals are delivered right after registration; pump briefly.
    let loop_ = mainloop.loop_();
    for _ in 0..15 {
        loop_.iterate(Duration::from_millis(20));
    }

    let out = sources.borrow().clone();
    Ok(out)
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
/// A trailing odd byte (incomplete sample) is ignored. We request S16_LE from
/// `pw-cat`; this is the capture→f32 boundary.
pub fn s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

// ---- pw-cat subprocess capture -------------------------------------------
//
// Each source is captured by a `pw-cat --record --raw` child that resamples,
// downmixes, and format-converts to S16 LE / 16 kHz / mono and writes headerless
// PCM to stdout. A reader thread converts that to f32 and VAD-windows it.

/// Build the `pw-cat` argv to capture `source` as raw S16/16k/mono on stdout.
/// `mic_target` pins the mic to a specific node (empty/None = PipeWire default).
fn pw_cat_command(source: AudioSource, mic_target: Option<&str>) -> Command {
    let mut cmd = Command::new("pw-cat");
    cmd.args([
        "--record",
        "--raw",
        "--format",
        "s16",
        "--rate",
        "16000",
        "--channels",
        "1",
    ]);
    match source {
        AudioSource::Mic => {
            if let Some(name) = mic_target {
                if !name.is_empty() {
                    cmd.args(["--target", name]);
                }
            }
        }
        // `stream.capture.sink=true` records the default sink's monitor.
        AudioSource::System => {
            cmd.args(["-P", "stream.capture.sink=true"]);
        }
    }
    cmd.arg("-"); // write PCM to stdout
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    cmd
}

/// Append `incoming` bytes to `carry`, decode all whole S16 samples, and keep a
/// trailing odd byte in `carry` so a sample split across reads isn't corrupted.
fn drain_samples(carry: &mut Vec<u8>, incoming: &[u8]) -> Vec<f32> {
    carry.extend_from_slice(incoming);
    let even = carry.len() & !1;
    let samples = s16le_to_f32(&carry[..even]);
    carry.drain(..even);
    samples
}

/// Handle to the running capture subprocesses (mic + system) and reader threads.
pub struct AudioCapture {
    should_stop: Arc<AtomicBool>,
    children: Vec<Child>,
    threads: Vec<JoinHandle<()>>,
}

impl AudioCapture {
    /// Spawn a `pw-cat` capture child per source plus a reader thread each.
    /// Returns the handle and a receiver of completed windows from BOTH sources.
    /// The receiver closes once both readers finish and drop their senders.
    pub fn start(mic_source: Option<String>) -> Result<(Self, Receiver<AudioWindow>), CaptureError> {
        let (tx, rx) = mpsc::channel::<AudioWindow>();
        let should_stop = Arc::new(AtomicBool::new(false));
        let mut cap = Self {
            should_stop: should_stop.clone(),
            children: Vec::new(),
            threads: Vec::new(),
        };

        let sources = [
            (AudioSource::Mic, mic_source.as_deref()),
            (AudioSource::System, None),
        ];
        for (source, target) in sources {
            let mut child = pw_cat_command(source, target).spawn().map_err(|e| {
                cap.kill_all();
                CaptureError::PipeWire(format!("spawn pw-cat ({}): {e}", source.as_str()))
            })?;
            let stdout = child.stdout.take();
            cap.children.push(child); // push first so kill_all covers it on error
            let Some(stdout) = stdout else {
                cap.kill_all();
                return Err(CaptureError::PipeWire(format!(
                    "pw-cat ({}) stdout unavailable",
                    source.as_str()
                )));
            };

            let tx = tx.clone();
            let stop = should_stop.clone();
            let thread = thread::Builder::new()
                .name(format!("rewindos-audio-{}", source.as_str()))
                .spawn(move || read_capture_stream(stdout, source, tx, stop))
                .map_err(|e| {
                    cap.kill_all();
                    CaptureError::PipeWire(format!("spawn reader ({}): {e}", source.as_str()))
                })?;
            cap.threads.push(thread);
        }

        // The original `tx` drops here; only the per-thread clones remain, so the
        // receiver closes once both reader threads exit.
        Ok((cap, rx))
    }

    /// Kill the capture children (closing their stdout) and join the readers.
    pub fn stop(mut self) {
        self.should_stop.store(true, Ordering::Release);
        self.kill_all();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }

    fn kill_all(&mut self) {
        for c in &mut self.children {
            let _ = c.kill();
        }
        for c in &mut self.children {
            let _ = c.wait();
        }
    }
}

/// Read raw S16 PCM from a capture child's stdout, VAD-window it, and forward
/// completed windows. Returns on stdout EOF (child exited) or when `stop` is set,
/// performing a tail flush first.
fn read_capture_stream(
    mut stdout: ChildStdout,
    source: AudioSource,
    tx: Sender<AudioWindow>,
    stop: Arc<AtomicBool>,
) {
    let mut windower = Windower::new(source);
    let mut carry = Vec::new();
    let mut buf = [0u8; 8192];
    let mut out = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        match stdout.read(&mut buf) {
            Ok(0) => break, // EOF — child exited
            Ok(n) => {
                let samples = drain_samples(&mut carry, &buf[..n]);
                out.clear();
                windower.push(&samples, &mut out);
                for w in out.drain(..) {
                    if tx.send(w).is_err() {
                        return; // receiver gone
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    out.clear();
    windower.flush(&mut out);
    for w in out.drain(..) {
        let _ = tx.send(w);
    }
}

// ---- Live mic level monitor ----------------------------------------------

/// A `pw-cat` preview capture that reports the mic's live RMS level (0.0..~1.0)
/// so the UI can show a meter while picking a source. Does not persist audio.
pub struct MicMonitor {
    should_stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>, // f32 bits
    child: Option<Child>,
    thread: Option<JoinHandle<()>>,
}

impl MicMonitor {
    pub fn start(mic_source: Option<String>) -> Result<Self, CaptureError> {
        let mut child = pw_cat_command(AudioSource::Mic, mic_source.as_deref())
            .spawn()
            .map_err(|e| CaptureError::PipeWire(format!("spawn pw-cat (monitor): {e}")))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CaptureError::PipeWire("pw-cat (monitor) stdout unavailable".into()))?;

        let should_stop = Arc::new(AtomicBool::new(false));
        let level = Arc::new(AtomicU32::new(0));
        let stop = should_stop.clone();
        let level_t = level.clone();
        let thread = thread::Builder::new()
            .name("rewindos-mic-monitor".into())
            .spawn(move || monitor_level(stdout, level_t, stop))
            .map_err(|e| {
                let _ = child.kill();
                CaptureError::PipeWire(format!("spawn monitor reader: {e}"))
            })?;

        Ok(Self {
            should_stop,
            level,
            child: Some(child),
            thread: Some(thread),
        })
    }

    /// Current RMS level (0.0 = silence). Read by the D-Bus `get_mic_level`.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn stop(mut self) {
        self.should_stop.store(true, Ordering::Release);
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

/// Read raw S16 from the monitor child's stdout and publish a rolling RMS level.
fn monitor_level(mut stdout: ChildStdout, level: Arc<AtomicU32>, stop: Arc<AtomicBool>) {
    let mut carry = Vec::new();
    let mut buf = [0u8; 4096];
    while !stop.load(Ordering::Relaxed) {
        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let samples = drain_samples(&mut carry, &buf[..n]);
                if !samples.is_empty() {
                    level.store(rms(&samples).to_bits(), Ordering::Relaxed);
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
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

    #[test]
    fn pw_cat_argv_includes_format_and_mic_target() {
        let cmd = pw_cat_command(AudioSource::Mic, Some("alsa_input.foo"));
        let argv: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(argv.iter().any(|a| a == "--record"));
        assert!(argv.iter().any(|a| a == "--raw"));
        assert!(argv.windows(2).any(|w| w[0] == "--format" && w[1] == "s16"));
        assert!(argv.windows(2).any(|w| w[0] == "--rate" && w[1] == "16000"));
        assert!(argv.windows(2).any(|w| w[0] == "--channels" && w[1] == "1"));
        assert!(argv
            .windows(2)
            .any(|w| w[0] == "--target" && w[1] == "alsa_input.foo"));
    }

    #[test]
    fn pw_cat_argv_system_captures_sink_and_omits_target() {
        let cmd = pw_cat_command(AudioSource::System, None);
        let argv: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(argv.iter().any(|a| a == "stream.capture.sink=true"));
        assert!(!argv.iter().any(|a| a == "--target"));
    }

    #[test]
    fn pw_cat_argv_mic_default_has_no_target() {
        for target in [None, Some("")] {
            let cmd = pw_cat_command(AudioSource::Mic, target);
            let argv: Vec<String> = cmd
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert!(!argv.iter().any(|a| a == "--target"), "target={target:?}");
        }
    }

    #[test]
    fn drain_samples_carries_split_sample_across_reads() {
        let mut carry = Vec::new();
        // one whole sample (2 bytes) + a leftover odd byte
        let s1 = drain_samples(&mut carry, &[0x00, 0x40, 0x11]);
        assert_eq!(s1.len(), 1);
        assert_eq!(carry, vec![0x11]); // odd byte held back
        // the next read completes the split sample
        let s2 = drain_samples(&mut carry, &[0x22]);
        assert_eq!(s2.len(), 1);
        assert!(carry.is_empty());
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

    #[test]
    #[ignore = "requires a live PipeWire daemon"]
    fn audiocapture_produces_windows() {
        let (cap, rx) = AudioCapture::start(None).expect("start capture");
        std::thread::sleep(std::time::Duration::from_secs(4));
        cap.stop(); // flushes + joins; senders drop, so rx iteration ends
        let windows: Vec<AudioWindow> = rx.iter().collect();
        assert!(!windows.is_empty(), "expected at least one window from capture");
        // At least the mic should produce audio; system may be silent if nothing plays.
        assert!(
            windows.iter().any(|w| w.source == AudioSource::Mic),
            "expected at least one mic window"
        );
        for w in &windows {
            assert!(!w.samples.is_empty());
        }
    }
}
