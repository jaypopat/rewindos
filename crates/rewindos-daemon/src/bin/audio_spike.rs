//! THROWAWAY SPIKE — Milestone 2 gate for the meeting-transcription feature.
//!
//! Goal: prove the `pipewire` 0.9 crate (as used by this codebase) can capture
//! BOTH the default sink monitor ("system" / Remote audio) AND the default mic
//! source ("mic" / You audio) as two simultaneous audio streams. The existing
//! capture path (`capture/portal.rs`) is screencast-VIDEO only, so audio capture
//! is unproven — this binary de-risks it before `capture/audio.rs` is written.
//!
//! It does NOT use xdg-desktop-portal: audio capture connects directly to the
//! running PipeWire daemon (no per-DE provider needed — the "audio is DE-agnostic"
//! claim from the design doc).
//!
//! Run:
//!   cargo run -p rewindos-daemon --bin audio_spike
//! Optional: play audio / speak while it runs (8 s window) to see non-zero peaks.
//!
//! Success = both streams reach Streaming and receive samples. It also dumps raw
//! PCM (in the NEGOTIATED format) to /tmp/audio_spike_{mic,system}.<fmt> so you
//! can sanity-check, e.g. for s16le mono 16k:
//!   ffplay -f s16le -ar 16000 -ch_layout mono /tmp/audio_spike_mic.s16le
//!
//! KEY FINDINGS (recorded for Milestone 2):
//!   * Forcing a single fixed format (f32-only) made negotiation FAIL — neither
//!     stream reached Streaming. Offering a Choice of formats negotiates fine.
//!   * The adapter here negotiates S16_LE, not F32_LE. So M2's capture code must
//!     OFFER a format Choice and PARSE param_changed to learn the real format,
//!     then convert to whisper's f32/16k itself (this spike parses + reports it).
//!
//! DELETE this file once Milestone 2's real `capture/audio.rs` lands.
//!
//! Mirrors the exact pipewire 0.9 idioms in `capture/portal.rs` (MainLoopBox /
//! ContextBox / StreamBox, manual `Value::Object` pod via `PodSerializer`, the
//! local SPA enum constants, and the `PodDeserializer` format-parse pattern).

use std::fs::File;
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pipewire as pw;
use pw::spa;
use pw::stream::{StreamFlags, StreamState};

// ---- SPA enum constants ---------------------------------------------------
// `spa_format` keys: audio at 0x0001_xxxx, video at 0x0002_xxxx. The video values
// are verbatim from portal.rs (which compiles against this crate), confirming the
// encoding; the audio values are the matching audio block from
// spa/param/audio/raw.h.
const SPA_FORMAT_MEDIA_TYPE: u32 = 1;
const SPA_FORMAT_MEDIA_SUBTYPE: u32 = 2;
const SPA_FORMAT_AUDIO_FORMAT: u32 = 0x0001_0001;
const SPA_FORMAT_AUDIO_RATE: u32 = 0x0001_0003;
const SPA_FORMAT_AUDIO_CHANNELS: u32 = 0x0001_0004;

// `spa_media_type`: audio=1, video=2 (portal.rs uses Id(2) for video).
const SPA_MEDIA_TYPE_AUDIO: u32 = 1;
// `spa_media_subtype`: raw=1 (portal.rs uses Id(1) for raw).
const SPA_MEDIA_SUBTYPE_RAW: u32 = 1;
// `spa_audio_format` interleaved block: S16_LE=0x102, F32_LE=0x11a.
const SPA_AUDIO_FORMAT_S16_LE: u32 = 0x0000_0102;
const SPA_AUDIO_FORMAT_F32_LE: u32 = 0x0000_011a;

const TARGET_RATE: u32 = 16_000;
const TARGET_CHANNELS: u32 = 1;
const RUN_SECONDS: u64 = 8;

/// Which audio source a stream is capturing.
#[derive(Clone, Copy)]
enum Source {
    /// Default mic (PipeWire default source) → "You".
    Mic,
    /// Default sink monitor (system output) → "Remote".
    System,
}

impl Source {
    fn label(self) -> &'static str {
        match self {
            Source::Mic => "mic",
            Source::System => "system",
        }
    }
}

/// The audio format the server actually fixated, parsed from param_changed.
#[derive(Clone, Copy)]
struct NegotiatedAudio {
    format_id: u32,
    rate: u32,
    channels: u32,
}

impl NegotiatedAudio {
    fn fmt_name(&self) -> &'static str {
        match self.format_id {
            SPA_AUDIO_FORMAT_S16_LE => "s16le",
            SPA_AUDIO_FORMAT_F32_LE => "f32le",
            _ => "other",
        }
    }
    fn bytes_per_sample(&self) -> usize {
        match self.format_id {
            SPA_AUDIO_FORMAT_S16_LE => 2,
            SPA_AUDIO_FORMAT_F32_LE => 4,
            _ => 0,
        }
    }
}

/// Per-stream observations, updated from the PipeWire process callback.
struct StreamStats {
    label: &'static str,
    samples: AtomicU64,
    /// Peak absolute amplitude (normalized 0..1), * 1000 for atomic int storage.
    peak_milli: AtomicU64,
    streamed: AtomicBool,
    fmt: Mutex<Option<NegotiatedAudio>>,
    /// Raw PCM dump (in negotiated format) for offline sanity-checking.
    pcm: Mutex<Vec<u8>>,
}

impl StreamStats {
    fn new(label: &'static str) -> Arc<Self> {
        Arc::new(Self {
            label,
            samples: AtomicU64::new(0),
            peak_milli: AtomicU64::new(0),
            streamed: AtomicBool::new(false),
            fmt: Mutex::new(None),
            pcm: Mutex::new(Vec::new()),
        })
    }
}

fn main() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    pw::init();

    match run() {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("\n[audio_spike] FAILED: {e}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<i32, String> {
    let mainloop =
        pw::main_loop::MainLoopBox::new(None).map_err(|e| format!("create main loop: {e}"))?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| format!("create context: {e}"))?;
    // No portal fd — connect straight to the running PipeWire daemon.
    let core = context
        .connect(None)
        .map_err(|e| format!("connect to PipeWire daemon: {e} (is PipeWire running?)"))?;

    let mic_stats = StreamStats::new("mic");
    let sys_stats = StreamStats::new("system");

    // Keep streams + listeners alive for the whole loop. Tuple-pattern bindings
    // drop in reverse (listener before its stream) — the order pipewire needs.
    let (_mic_stream, _mic_listener) = build_stream(&core, Source::Mic, mic_stats.clone())?;
    let (_sys_stream, _sys_listener) = build_stream(&core, Source::System, sys_stats.clone())?;

    println!(
        "[audio_spike] capturing mic + system monitor for {RUN_SECONDS}s \
         (requesting {TARGET_RATE} Hz / {TARGET_CHANNELS}ch)…"
    );
    println!("[audio_spike] tip: play audio and/or speak now.");

    let loop_ = mainloop.loop_();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(RUN_SECONDS);
    while std::time::Instant::now() < deadline {
        loop_.iterate(std::time::Duration::from_millis(100));
    }

    // ---- Report --------------------------------------------------------
    let mut ok = true;
    for stats in [&mic_stats, &sys_stats] {
        let samples = stats.samples.load(Ordering::Relaxed);
        let peak = stats.peak_milli.load(Ordering::Relaxed) as f64 / 1000.0;
        let streamed = stats.streamed.load(Ordering::Relaxed);
        let fmt = *stats.fmt.lock().unwrap();
        let (fmt_name, rate, channels) = match fmt {
            Some(f) => (f.fmt_name(), f.rate, f.channels),
            None => ("<none>", 0, 0),
        };

        println!(
            "\n[audio_spike] {:<7} streamed={streamed} format={fmt_name} \
             rate={rate} ch={channels} samples={samples} peak={peak:.4}",
            stats.label
        );

        let pcm = stats.pcm.lock().unwrap();
        if !pcm.is_empty() {
            let path = format!("/tmp/audio_spike_{}.{}", stats.label, fmt_name);
            match File::create(&path).and_then(|mut f| f.write_all(&pcm)) {
                Ok(()) => println!(
                    "[audio_spike] {:<7} wrote {} ({} bytes)",
                    stats.label,
                    path,
                    pcm.len()
                ),
                Err(e) => eprintln!("[audio_spike] {:<7} dump failed: {e}", stats.label),
            }
        }

        // Hard pass for this stream = streamed AND received samples. (Peak may be
        // legitimately ~0 if the mic is muted or nothing is playing on the sink.)
        if !streamed || samples == 0 {
            ok = false;
            eprintln!(
                "[audio_spike] {:<7} did NOT capture (streamed={streamed}, samples={samples}). \
                 Check the {} is available/unmuted.",
                stats.label,
                match stats.label {
                    "mic" => "default source (microphone)",
                    _ => "default sink monitor",
                }
            );
        }
    }

    if ok {
        println!(
            "\n[audio_spike] SUCCESS — pipewire 0.9 captured both the mic source and the \
             sink monitor. Milestone 2 audio capture is viable.\n\
             [audio_spike] M2 note: negotiated format is shown above (expect s16le); the real \
             capture stage must parse it and convert to f32/16k for whisper."
        );
        Ok(0)
    } else {
        eprintln!(
            "\n[audio_spike] INCOMPLETE — at least one stream produced no samples. If it \
             streamed but got nothing, the wiring is wrong; if it never streamed, the \
             device/target selection needs adjusting."
        );
        Ok(2)
    }
}

/// Create one audio capture stream, register a stats listener, connect it
/// (autoconnect to the PipeWire default for this stream kind). Returns the
/// stream + listener so the caller keeps them alive.
#[allow(clippy::type_complexity)]
fn build_stream<'c>(
    core: &'c pw::core::Core,
    source: Source,
    stats: Arc<StreamStats>,
) -> Result<(pw::stream::StreamBox<'c>, pw::stream::StreamListener<()>), String> {
    // Mic: plain audio Capture stream → default source.
    // System: `stream.capture.sink = true` flips a Capture stream to record the
    // default sink's MONITOR (system output).
    let props = match source {
        Source::Mic => pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Communication",
            *pw::keys::NODE_NAME => "rewindos-spike-mic",
        },
        Source::System => pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Music",
            *pw::keys::NODE_NAME => "rewindos-spike-system",
            "stream.capture.sink" => "true",
        },
    };

    let stream = pw::stream::StreamBox::new(core, "rewindos-audio-spike", props)
        .map_err(|e| format!("create {} stream: {e}", source.label()))?;

    let stats_state = stats.clone();
    let stats_param = stats.clone();
    let stats_proc = stats.clone();

    let listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(move |_, _, old, new| match &new {
            StreamState::Streaming => {
                stats_state.streamed.store(true, Ordering::Release);
                tracing::info!(label = stats_state.label, ?old, "stream streaming");
            }
            StreamState::Error(msg) => {
                tracing::warn!(label = stats_state.label, error = %msg, "stream error");
            }
            _ => tracing::debug!(label = stats_state.label, ?old, ?new, "stream state"),
        })
        .param_changed(move |_, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            match parse_audio_format(param) {
                Ok(f) => {
                    tracing::info!(
                        label = stats_param.label,
                        format = f.fmt_name(),
                        rate = f.rate,
                        channels = f.channels,
                        "format negotiated"
                    );
                    *stats_param.fmt.lock().unwrap() = Some(f);
                }
                Err(e) => tracing::warn!(label = stats_param.label, "parse format: {e}"),
            }
        })
        .process(move |stream, _| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let fmt = *stats_proc.fmt.lock().unwrap();
            let Some(fmt) = fmt else { return };
            let bps = fmt.bytes_per_sample();
            if bps == 0 {
                return; // unknown format; can't interpret
            }

            let data = &mut datas[0];
            let n_bytes = data.chunk().size() as usize;
            let Some(slice) = data.data() else { return };
            let valid = &slice[..n_bytes.min(slice.len())];

            let mut peak = stats_proc.peak_milli.load(Ordering::Relaxed) as f32 / 1000.0;
            let mut count: u64 = 0;
            for sample in valid.chunks_exact(bps) {
                let norm = match fmt.format_id {
                    SPA_AUDIO_FORMAT_F32_LE => {
                        f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])
                    }
                    SPA_AUDIO_FORMAT_S16_LE => {
                        i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0
                    }
                    _ => 0.0,
                };
                let a = norm.abs();
                if a.is_finite() && a > peak {
                    peak = a;
                }
                count += 1;
            }
            if count > 0 {
                stats_proc.samples.fetch_add(count, Ordering::Relaxed);
                stats_proc
                    .peak_milli
                    .store((peak * 1000.0) as u64, Ordering::Relaxed);
                // Bound the dump to ~RUN_SECONDS of audio.
                let mut pcm = stats_proc.pcm.lock().unwrap();
                let cap = (TARGET_RATE as usize) * (TARGET_CHANNELS as usize) * bps * (RUN_SECONDS as usize);
                if pcm.len() < cap {
                    pcm.extend_from_slice(valid);
                }
            }
        })
        .register()
        .map_err(|e| format!("register {} listener: {e}", source.label()))?;

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
        .map_err(|e| format!("connect {} stream: {e}", source.label()))?;

    tracing::info!(label = source.label(), "stream connect() issued");
    Ok((stream, listener))
}

/// Build the SPA audio-format EnumFormat pod (mirrors `build_video_params`).
/// Offers F32_LE + S16_LE so the server can fixate one.
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
            // format = F32_LE preferred, S16_LE accepted.
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
                value: Value::Int(TARGET_RATE as i32),
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

/// Read an Id (u32) from a pod value, bare or Choice-wrapped (mirrors portal.rs).
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

/// Parse the negotiated audio format from a SPA pod (mirrors parse_video_format).
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
