//! Meeting audio capture: two PipeWire input streams (mic + sink monitor),
//! VAD-windowed into f32 PCM windows. See `src/bin/audio_spike.rs` for the
//! proven pipewire wiring this builds on.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipewire as pw;
use pw::spa;
use pw::stream::{StreamFlags, StreamState};

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
/// A trailing odd byte (incomplete sample) is ignored. The spike confirmed
/// PipeWire negotiates S16_LE here; this is the capture→f32 boundary.
pub fn s16le_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

// ---- PipeWire dual-stream capture ----------------------------------------
//
// Ported from `src/bin/audio_spike.rs` (the proven spike). The spike offers a
// format Choice (F32_LE preferred, S16_LE accepted — forcing one fails
// negotiation), learns the fixated format in `param_changed`, and converts the
// raw PCM to f32 in `process`. Here we feed each stream's samples into a
// per-source `Windower` and forward completed windows over an mpsc channel.

// `spa_format` keys (audio block from spa/param/audio/raw.h).
const SPA_FORMAT_MEDIA_TYPE: u32 = 1;
const SPA_FORMAT_MEDIA_SUBTYPE: u32 = 2;
const SPA_FORMAT_AUDIO_FORMAT: u32 = 0x0001_0001;
const SPA_FORMAT_AUDIO_RATE: u32 = 0x0001_0003;
const SPA_FORMAT_AUDIO_CHANNELS: u32 = 0x0001_0004;

const SPA_MEDIA_TYPE_AUDIO: u32 = 1;
const SPA_MEDIA_SUBTYPE_RAW: u32 = 1;
const SPA_AUDIO_FORMAT_S16_LE: u32 = 0x0000_0102;
const SPA_AUDIO_FORMAT_F32_LE: u32 = 0x0000_011a;

const TARGET_CHANNELS: u32 = 1;

/// The audio format the server actually fixated, parsed from `param_changed`.
#[derive(Clone, Copy)]
struct NegotiatedAudio {
    format_id: u32,
    #[allow(dead_code)]
    rate: u32,
    #[allow(dead_code)]
    channels: u32,
}

impl NegotiatedAudio {
    fn bytes_per_sample(&self) -> usize {
        match self.format_id {
            SPA_AUDIO_FORMAT_S16_LE => 2,
            SPA_AUDIO_FORMAT_F32_LE => 4,
            _ => 0,
        }
    }
}

/// Handle to a running dual-stream PipeWire capture thread.
pub struct AudioCapture {
    should_stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl AudioCapture {
    /// Spawn the PipeWire capture thread. Returns the handle plus a receiver of
    /// completed windows from BOTH sources (mic + system monitor). The receiver
    /// closes once the thread stops and drops its senders (see [`stop`]).
    pub fn start(mic_source: Option<String>) -> Result<(Self, Receiver<AudioWindow>), CaptureError> {
        let (tx, rx) = mpsc::channel::<AudioWindow>();
        let should_stop = Arc::new(AtomicBool::new(false));
        let stop_for_thread = should_stop.clone();

        let thread = std::thread::Builder::new()
            .name("rewindos-audio".into())
            .spawn(move || {
                if let Err(e) = run_capture(stop_for_thread, tx, mic_source) {
                    tracing::error!(error = %e, "audio capture thread exited with error");
                }
            })
            .map_err(|e| CaptureError::PipeWire(format!("spawn audio thread: {e}")))?;

        Ok((
            Self {
                should_stop,
                thread: Some(thread),
            },
            rx,
        ))
    }

    /// Signal the thread to stop and join it. The thread flushes both Windowers
    /// (tail flush) and sends the remaining windows before dropping its senders.
    pub fn stop(mut self) {
        self.should_stop.store(true, Ordering::Release);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

/// Owns the PipeWire mainloop, context, core, and both streams for the lifetime
/// of the capture loop. `core` and the streams must outlive the loop, so they
/// stay in local bindings here (they are not returned across the thread).
fn run_capture(
    should_stop: Arc<AtomicBool>,
    tx: Sender<AudioWindow>,
    mic_source: Option<String>,
) -> Result<(), CaptureError> {
    pw::init();

    let mainloop = pw::main_loop::MainLoopBox::new(None)
        .map_err(|e| CaptureError::PipeWire(format!("create main loop: {e}")))?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| CaptureError::PipeWire(format!("create context: {e}")))?;
    // No portal fd — connect straight to the running PipeWire daemon.
    let core = context
        .connect(None)
        .map_err(|e| CaptureError::PipeWire(format!("connect to PipeWire daemon: {e}")))?;

    // Per-source Windowers, shared with the process closures so they can be
    // flushed after the loop exits.
    let mic_windower = Arc::new(Mutex::new(Windower::new(AudioSource::Mic)));
    let sys_windower = Arc::new(Mutex::new(Windower::new(AudioSource::System)));

    // Keep streams + listeners alive for the whole loop. Tuple-pattern bindings
    // drop in reverse (listener before its stream) — the order pipewire needs.
    let (_mic_stream, _mic_listener) = build_stream(
        &core,
        AudioSource::Mic,
        mic_windower.clone(),
        tx.clone(),
        mic_source.as_deref(),
    )?;
    let (_sys_stream, _sys_listener) =
        build_stream(&core, AudioSource::System, sys_windower.clone(), tx.clone(), None)?;

    tracing::info!("audio capture: mic + system streams connected");

    let loop_ = mainloop.loop_();
    while !should_stop.load(Ordering::Relaxed) {
        loop_.iterate(Duration::from_millis(50));
    }

    // Tail flush: emit whatever remains in each Windower.
    let mut out = Vec::new();
    for w in [&mic_windower, &sys_windower] {
        out.clear();
        w.lock().unwrap().flush(&mut out);
        for window in out.drain(..) {
            let _ = tx.send(window);
        }
    }

    // Streams, listeners, and the local `tx` clones drop here; the original `tx`
    // moved into this fn drops on return, closing the receiver.
    Ok(())
}

/// Create one audio capture stream, register its listener, and connect it
/// (autoconnect to the PipeWire default for this stream kind). Returns the
/// stream + listener so the caller keeps them alive.
#[allow(clippy::type_complexity)]
fn build_stream<'c>(
    core: &'c pw::core::Core,
    source: AudioSource,
    windower: Arc<Mutex<Windower>>,
    tx: Sender<AudioWindow>,
    mic_target: Option<&str>,
) -> Result<(pw::stream::StreamBox<'c>, pw::stream::StreamListener<()>), CaptureError> {
    // Mic: plain audio Capture stream → default source.
    // System: `stream.capture.sink = true` flips a Capture stream to record the
    // default sink's MONITOR (system output).
    let mut props = match source {
        AudioSource::Mic => pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Communication",
            *pw::keys::NODE_NAME => "rewindos-mic",
        },
        AudioSource::System => pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Music",
            *pw::keys::NODE_NAME => "rewindos-system",
            "stream.capture.sink" => "true",
        },
    };

    // Pin the mic stream to a specific source when one was selected; an empty
    // selection (or System) keeps PipeWire's autoconnect default.
    if source == AudioSource::Mic {
        if let Some(name) = mic_target {
            if !name.is_empty() {
                props.insert("target.object", name);
            }
        }
    }

    let stream = pw::stream::StreamBox::new(core, "rewindos-audio", props)
        .map_err(|e| CaptureError::PipeWire(format!("create {} stream: {e}", source.as_str())))?;

    // Negotiated format, learned in param_changed and read in process.
    let fmt: Arc<Mutex<Option<NegotiatedAudio>>> = Arc::new(Mutex::new(None));
    let fmt_param = fmt.clone();
    let fmt_proc = fmt.clone();
    let label = source.as_str();

    let listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(move |_, _, old, new| match &new {
            StreamState::Streaming => {
                tracing::info!(label, ?old, "audio stream streaming");
            }
            StreamState::Error(msg) => {
                tracing::warn!(label, error = %msg, "audio stream error");
            }
            _ => tracing::debug!(label, ?old, ?new, "audio stream state"),
        })
        .param_changed(move |_, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            match parse_audio_format(param) {
                Ok(f) => {
                    tracing::info!(
                        label,
                        format_id = f.format_id,
                        rate = f.rate,
                        channels = f.channels,
                        "audio format negotiated"
                    );
                    *fmt_param.lock().unwrap() = Some(f);
                }
                Err(e) => tracing::warn!(label, "parse audio format: {e}"),
            }
        })
        .process(move |stream, _| {
            let fmt = *fmt_proc.lock().unwrap();
            let Some(fmt) = fmt else { return };
            let bps = fmt.bytes_per_sample();
            if bps == 0 {
                return; // unknown format; can't interpret
            }

            let mut out = Vec::new();
            // Drain ALL available buffers (the spike under-read one per call).
            while let Some(mut buffer) = stream.dequeue_buffer() {
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    continue;
                }
                let data = &mut datas[0];
                let n_bytes = data.chunk().size() as usize;
                let Some(slice) = data.data() else { continue };
                let valid = &slice[..n_bytes.min(slice.len())];
                if valid.is_empty() {
                    continue;
                }

                let samples: Vec<f32> = match fmt.format_id {
                    SPA_AUDIO_FORMAT_S16_LE => s16le_to_f32(valid),
                    SPA_AUDIO_FORMAT_F32_LE => valid
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect(),
                    _ => continue,
                };

                out.clear();
                windower.lock().unwrap().push(&samples, &mut out);
                for w in out.drain(..) {
                    let _ = tx.send(w);
                }
            }
        })
        .register()
        .map_err(|e| CaptureError::PipeWire(format!("register {} listener: {e}", source.as_str())))?;

    // Offer a Choice of formats so negotiation succeeds (forcing one fails).
    let mut params_buf = vec![0u8; 1024];
    let params_pod = build_audio_params(&mut params_buf);

    stream
        .connect(
            spa::utils::Direction::Input,
            None,
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut [params_pod],
        )
        .map_err(|e| CaptureError::PipeWire(format!("connect {} stream: {e}", source.as_str())))?;

    Ok((stream, listener))
}

// ---- Live mic level monitor ----------------------------------------------

/// A short-lived preview stream that reports the mic's live RMS level (0.0..~1.0)
/// so the UI can show a meter while picking a source. Does not record.
pub struct MicMonitor {
    should_stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>, // f32 bits
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MicMonitor {
    pub fn start(mic_source: Option<String>) -> Result<Self, CaptureError> {
        let should_stop = Arc::new(AtomicBool::new(false));
        let level = Arc::new(AtomicU32::new(0));
        let stop_t = should_stop.clone();
        let level_t = level.clone();
        let thread = std::thread::Builder::new()
            .name("rewindos-mic-monitor".into())
            .spawn(move || {
                if let Err(e) = run_monitor(stop_t, level_t, mic_source) {
                    tracing::warn!(error = %e, "mic monitor exited with error");
                }
            })
            .map_err(|e| CaptureError::PipeWire(format!("spawn monitor thread: {e}")))?;
        Ok(Self {
            should_stop,
            level,
            thread: Some(thread),
        })
    }

    /// Current RMS level (0.0 = silence). Read by the D-Bus `get_mic_level`.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }

    pub fn stop(mut self) {
        self.should_stop.store(true, Ordering::Release);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

fn run_monitor(
    should_stop: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
    mic_source: Option<String>,
) -> Result<(), CaptureError> {
    pw::init();

    let mainloop = pw::main_loop::MainLoopBox::new(None)
        .map_err(|e| CaptureError::PipeWire(format!("monitor: main loop: {e}")))?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| CaptureError::PipeWire(format!("monitor: context: {e}")))?;
    let core = context
        .connect(None)
        .map_err(|e| CaptureError::PipeWire(format!("monitor: connect: {e}")))?;

    // Single mic Capture stream — mirrors build_stream's Mic branch.
    let mut props = pw::properties::properties! {
        *pw::keys::MEDIA_TYPE => "Audio",
        *pw::keys::MEDIA_CATEGORY => "Capture",
        *pw::keys::MEDIA_ROLE => "Communication",
        *pw::keys::NODE_NAME => "rewindos-mic-monitor",
    };
    if let Some(name) = mic_source.as_deref() {
        if !name.is_empty() {
            props.insert("target.object", name);
        }
    }

    let stream = pw::stream::StreamBox::new(&core, "rewindos-mic-monitor", props)
        .map_err(|e| CaptureError::PipeWire(format!("monitor: create stream: {e}")))?;

    let fmt: Arc<Mutex<Option<NegotiatedAudio>>> = Arc::new(Mutex::new(None));
    let fmt_param = fmt.clone();
    let fmt_proc = fmt.clone();
    let level_proc = level.clone();

    let listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(|_, _, old, new| match &new {
            StreamState::Error(msg) => {
                tracing::warn!(error = %msg, "mic monitor stream error");
            }
            _ => tracing::debug!(?old, ?new, "mic monitor stream state"),
        })
        .param_changed(move |_, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            match parse_audio_format(param) {
                Ok(f) => *fmt_param.lock().unwrap() = Some(f),
                Err(e) => tracing::warn!("mic monitor parse audio format: {e}"),
            }
        })
        .process(move |stream, _| {
            let fmt = *fmt_proc.lock().unwrap();
            let Some(fmt) = fmt else { return };
            let bps = fmt.bytes_per_sample();
            if bps == 0 {
                return;
            }

            while let Some(mut buffer) = stream.dequeue_buffer() {
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    continue;
                }
                let data = &mut datas[0];
                let n_bytes = data.chunk().size() as usize;
                let Some(slice) = data.data() else { continue };
                let valid = &slice[..n_bytes.min(slice.len())];
                if valid.is_empty() {
                    continue;
                }

                let samples: Vec<f32> = match fmt.format_id {
                    SPA_AUDIO_FORMAT_S16_LE => s16le_to_f32(valid),
                    SPA_AUDIO_FORMAT_F32_LE => valid
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect(),
                    _ => continue,
                };
                if samples.is_empty() {
                    continue;
                }
                let lvl = rms(&samples);
                level_proc.store(lvl.to_bits(), Ordering::Relaxed);
            }
        })
        .register()
        .map_err(|e| CaptureError::PipeWire(format!("monitor: register listener: {e}")))?;

    let mut params_buf = vec![0u8; 1024];
    let params_pod = build_audio_params(&mut params_buf);

    stream
        .connect(
            spa::utils::Direction::Input,
            None,
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut [params_pod],
        )
        .map_err(|e| CaptureError::PipeWire(format!("monitor: connect stream: {e}")))?;

    // Keep stream + listener alive for the loop. Local drop order is reverse of
    // declaration, so the listener (last) drops before its stream — as pipewire
    // needs. Re-bind to make that explicit.
    let _stream = stream;
    let _listener = listener;

    let loop_ = mainloop.loop_();
    while !should_stop.load(Ordering::Relaxed) {
        loop_.iterate(Duration::from_millis(50));
    }

    Ok(())
}

/// Build the SPA audio-format EnumFormat pod. Offers F32_LE + S16_LE so the
/// server can fixate one (forcing a single format fails negotiation).
fn build_audio_params(buf: &mut [u8]) -> &spa::pod::Pod {
    use spa::pod::serialize::PodSerializer;
    use spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
    use spa::utils::{Choice, ChoiceEnum, ChoiceFlags, Id};

    let obj = Value::Object(Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: vec![
            Property {
                key: SPA_FORMAT_MEDIA_TYPE,
                value: Value::Id(Id(SPA_MEDIA_TYPE_AUDIO)),
                flags: PropertyFlags::empty(),
            },
            Property {
                key: SPA_FORMAT_MEDIA_SUBTYPE,
                value: Value::Id(Id(SPA_MEDIA_SUBTYPE_RAW)),
                flags: PropertyFlags::empty(),
            },
            Property {
                key: SPA_FORMAT_AUDIO_FORMAT,
                value: Value::Choice(ChoiceValue::Id(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum {
                        default: Id(SPA_AUDIO_FORMAT_F32_LE),
                        alternatives: vec![
                            Id(SPA_AUDIO_FORMAT_F32_LE),
                            Id(SPA_AUDIO_FORMAT_S16_LE),
                        ],
                    },
                ))),
                flags: PropertyFlags::empty(),
            },
            Property {
                key: SPA_FORMAT_AUDIO_RATE,
                value: Value::Int(CAPTURE_RATE as i32),
                flags: PropertyFlags::empty(),
            },
            Property {
                key: SPA_FORMAT_AUDIO_CHANNELS,
                value: Value::Int(TARGET_CHANNELS as i32),
                flags: PropertyFlags::empty(),
            },
        ],
    });

    let (result, _) = PodSerializer::serialize(std::io::Cursor::new(buf), &obj)
        .expect("serialize audio params pod");

    unsafe {
        let ptr = result.into_inner().as_ptr();
        &*(ptr as *const spa::pod::Pod)
    }
}

/// Read an Id (u32) from a pod value, bare or Choice-wrapped.
fn extract_id(value: &spa::pod::Value) -> Option<u32> {
    use spa::pod::{ChoiceValue, Value};
    match value {
        Value::Id(id) => Some(id.0),
        Value::Choice(ChoiceValue::Id(c)) => Some(choice_default_id(c)),
        _ => None,
    }
}

/// Read an i32 from a pod value, bare or Choice-wrapped.
fn extract_int(value: &spa::pod::Value) -> Option<i32> {
    use spa::pod::{ChoiceValue, Value};
    use spa::utils::ChoiceEnum;
    match value {
        Value::Int(i) => Some(*i),
        Value::Choice(ChoiceValue::Int(c)) => Some(match &c.1 {
            ChoiceEnum::None(v) => *v,
            ChoiceEnum::Range { default, .. } => *default,
            ChoiceEnum::Step { default, .. } => *default,
            ChoiceEnum::Enum { default, .. } => *default,
            ChoiceEnum::Flags { default, .. } => *default,
        }),
        _ => None,
    }
}

fn choice_default_id(choice: &spa::utils::Choice<spa::utils::Id>) -> u32 {
    use spa::utils::ChoiceEnum;
    match &choice.1 {
        ChoiceEnum::None(v) => v.0,
        ChoiceEnum::Range { default, .. } => default.0,
        ChoiceEnum::Step { default, .. } => default.0,
        ChoiceEnum::Enum { default, .. } => default.0,
        ChoiceEnum::Flags { default, .. } => default.0,
    }
}

/// Parse the negotiated audio format from a SPA pod.
fn parse_audio_format(param: &spa::pod::Pod) -> Result<NegotiatedAudio, String> {
    use spa::pod::deserialize::PodDeserializer;
    use spa::pod::Value;

    let (_, value) = PodDeserializer::deserialize_any_from(param.as_bytes())
        .map_err(|e| format!("pod deserialize: {e:?}"))?;
    let Value::Object(obj) = value else {
        return Err("expected Object pod".into());
    };

    let mut format_id = 0u32;
    let mut rate = 0u32;
    let mut channels = 0u32;
    for prop in &obj.properties {
        match prop.key {
            SPA_FORMAT_AUDIO_FORMAT => {
                if let Some(id) = extract_id(&prop.value) {
                    format_id = id;
                }
            }
            SPA_FORMAT_AUDIO_RATE => {
                if let Some(r) = extract_int(&prop.value) {
                    rate = r as u32;
                }
            }
            SPA_FORMAT_AUDIO_CHANNELS => {
                if let Some(c) = extract_int(&prop.value) {
                    channels = c as u32;
                }
            }
            _ => {}
        }
    }

    if format_id == 0 {
        return Err("missing audio format in negotiated pod".into());
    }
    Ok(NegotiatedAudio {
        format_id,
        rate,
        channels,
    })
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
