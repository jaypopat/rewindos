use std::os::fd::IntoRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rewindos_core::schema::RawFrame;
use tracing::{debug, error, info, warn};

use super::CaptureError;

/// Path to the stored portal restore token.
fn restore_token_path() -> PathBuf {
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            PathBuf::from(home).join(".local/share")
        });
    data_dir.join("rewindos").join("portal-restore-token")
}

fn load_restore_token() -> Option<String> {
    let path = restore_token_path();
    match std::fs::read_to_string(&path) {
        Ok(token) if !token.trim().is_empty() => {
            debug!(path = %path.display(), "loaded portal restore token");
            Some(token.trim().to_string())
        }
        _ => None,
    }
}

fn save_restore_token(token: &str) {
    let path = restore_token_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, token) {
        Ok(()) => debug!(path = %path.display(), "saved portal restore token"),
        Err(e) => warn!(error = %e, "failed to save portal restore token"),
    }
}

/// Frame data shared between PipeWire thread and async capture_frame().
struct FrameData {
    pixels: Vec<u8>,
    width: u32,
    height: u32,
}

struct SharedState {
    frame: Mutex<Option<FrameData>>,
    ready: AtomicBool,
}

/// xdg-desktop-portal + PipeWire capture backend.
///
/// Works on any Wayland compositor that implements the ScreenCast portal:
/// KDE Plasma, GNOME Shell, Hyprland, Sway, etc.
pub struct PortalCaptureBackend {
    shared: Arc<SharedState>,
    pw_thread: Option<std::thread::JoinHandle<()>>,
    should_stop: Arc<AtomicBool>,
}

impl PortalCaptureBackend {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(SharedState {
                frame: Mutex::new(None),
                ready: AtomicBool::new(false),
            }),
            pw_thread: None,
            should_stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl super::CaptureBackend for PortalCaptureBackend {
    fn name(&self) -> &'static str {
        "xdg-desktop-portal + PipeWire"
    }

    async fn initialize(&mut self) -> Result<(), CaptureError> {
        use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType};

        info!("initializing xdg-desktop-portal screencast session");

        // Load any previously saved restore token (avoids re-showing permission dialog)
        let restore_token = load_restore_token();
        if restore_token.is_some() {
            info!("using saved portal restore token to skip permission dialog");
        }

        // Create ScreenCast proxy and session
        let screencast = Screencast::new()
            .await
            .map_err(|e| CaptureError::Portal(format!("failed to connect to portal: {e}")))?;

        let session = screencast
            .create_session()
            .await
            .map_err(|e| CaptureError::Portal(format!("failed to create session: {e}")))?;

        // Select sources: capture a full monitor, hide cursor
        // Use ExplicitlyRevoked persist mode so the portal remembers the selection
        screencast
            .select_sources(
                &session,
                CursorMode::Hidden,
                SourceType::Monitor.into(),
                false,
                restore_token.as_deref(),
                ashpd::desktop::PersistMode::ExplicitlyRevoked,
            )
            .await
            .map_err(|e| CaptureError::Portal(format!("failed to select sources: {e}")))?;

        // Start the screencast (may trigger compositor permission dialog on first run)
        let request = screencast
            .start(&session, None)
            .await
            .map_err(|e| CaptureError::Portal(format!("failed to start screencast: {e}")))?;

        let response = request
            .response()
            .map_err(|e| CaptureError::Portal(format!("screencast start response error: {e}")))?;

        // Save the restore token for next startup
        if let Some(token) = response.restore_token() {
            save_restore_token(token);
        }

        let streams = response.streams();
        if streams.is_empty() {
            return Err(CaptureError::Portal("no streams returned by portal".into()));
        }

        let node_id = streams[0].pipe_wire_node_id();
        info!(node_id, "portal screencast started, spawning PipeWire stream");

        // Get PipeWire remote fd
        let pw_fd = screencast
            .open_pipe_wire_remote(&session)
            .await
            .map_err(|e| CaptureError::Portal(format!("failed to open PipeWire remote: {e}")))?;

        // Convert to raw fd for PipeWire thread
        let pw_raw_fd = pw_fd.into_raw_fd();

        // Spawn dedicated thread for PipeWire main loop
        let shared = self.shared.clone();
        let should_stop = self.should_stop.clone();

        let handle = std::thread::Builder::new()
            .name("rewindos-pipewire".into())
            .spawn(move || {
                if let Err(e) = run_pipewire_loop(pw_raw_fd, node_id, shared, should_stop) {
                    error!("PipeWire thread exited with error: {e}");
                }
            })
            .map_err(|e| CaptureError::PipeWire(format!("failed to spawn PipeWire thread: {e}")))?;

        self.pw_thread = Some(handle);

        // Wait briefly for the first frame to arrive
        for _ in 0..50 {
            if self.shared.ready.load(Ordering::Acquire) {
                info!("PipeWire stream delivering frames");
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        warn!("PipeWire stream started but no frames received within 5s — capture may be delayed");
        Ok(())
    }

    async fn capture_frame(&mut self) -> Result<RawFrame, CaptureError> {
        let frame = self.shared.frame.lock().unwrap().take();
        match frame {
            Some(data) => {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;

                Ok(RawFrame {
                    pixels: data.pixels,
                    width: data.width,
                    height: data.height,
                    timestamp,
                    app_name: None,
                    window_title: None,
                    window_class: None,
                })
            }
            None => Err(CaptureError::PipeWire("no frame available yet".into())),
        }
    }

    async fn shutdown(&mut self) -> Result<(), CaptureError> {
        info!("shutting down PipeWire capture");
        self.should_stop.store(true, Ordering::Release);

        if let Some(handle) = self.pw_thread.take() {
            // Give the thread a moment to exit gracefully
            let _ = tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            })
            .await;
        }

        Ok(())
    }
}

/// Run the PipeWire main loop on a dedicated thread.
///
/// Connects to PipeWire using the portal-provided fd, creates a video stream
/// targeting the given node_id, and writes captured frames to shared state.
fn run_pipewire_loop(
    pw_fd: i32,
    node_id: u32,
    shared: Arc<SharedState>,
    should_stop: Arc<AtomicBool>,
) -> Result<(), String> {
    use pipewire as pw;
    use pw::spa;
    use pw::stream::{StreamBox, StreamFlags};

    let mainloop = pw::main_loop::MainLoopBox::new(None)
        .map_err(|e| format!("failed to create PipeWire main loop: {e}"))?;
    let context = pw::context::ContextBox::new(mainloop.loop_(), None)
        .map_err(|e| format!("failed to create PipeWire context: {e}"))?;

    // Connect to PipeWire using the portal-provided fd
    let pw_fd_owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(pw_fd) };
    let core = context
        .connect_fd(pw_fd_owned, None)
        .map_err(|e| format!("failed to connect PipeWire fd: {e}"))?;

    let stream = StreamBox::new(
        &core,
        "rewindos-capture",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|e| format!("failed to create PipeWire stream: {e}"))?;

    // Track negotiated video format
    let format_info: Arc<Mutex<Option<VideoFormat>>> = Arc::new(Mutex::new(None));
    let format_info_process = format_info.clone();
    let shared_process = shared.clone();

    let _listener = stream
        .add_local_listener_with_user_data(())
        .param_changed(move |_, _, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }

            // Parse the negotiated video format
            match parse_video_format(param) {
                Ok(fmt) => {
                    info!(
                        width = fmt.width,
                        height = fmt.height,
                        format = ?fmt.spa_format,
                        "PipeWire stream format negotiated"
                    );
                    *format_info.lock().unwrap() = Some(fmt);
                }
                Err(e) => {
                    warn!("failed to parse PipeWire video format: {e}");
                }
            }
        })
        .process(move |stream, _| {
            // Only copy frame if the consumer has taken the previous one
            let needs_frame = shared_process.frame.lock().unwrap().is_none();
            if !needs_frame {
                // Still need to dequeue and queue the buffer even if we skip
                if let Some(mut buffer) = stream.dequeue_buffer() {
                    let _ = &buffer; // keep borrow alive for requeue
                    let _ = buffer.datas_mut(); // access data to ensure buffer is processed
                }
                return;
            }

            let fmt = format_info_process.lock().unwrap().clone();
            let Some(fmt) = fmt else {
                // Format not yet negotiated
                if let Some(buffer) = stream.dequeue_buffer() {
                    drop(buffer);
                }
                return;
            };

            if let Some(mut buffer) = stream.dequeue_buffer() {
                let datas = buffer.datas_mut();
                if datas.is_empty() {
                    return;
                }

                let data = &mut datas[0];
                let stride = data.chunk().stride() as u32;
                let Some(slice) = data.data() else { return };
                let rgba = convert_spa_to_rgba(slice, fmt.width, fmt.height, stride, fmt.spa_format);

                *shared_process.frame.lock().unwrap() = Some(FrameData {
                    pixels: rgba,
                    width: fmt.width,
                    height: fmt.height,
                });
                shared_process.ready.store(true, Ordering::Release);
            }
        })
        .register()
        .map_err(|e| format!("failed to register PipeWire listener: {e}"))?;

    // Build format parameters for stream connection
    let mut params_buf = vec![0u8; 1024];
    let params_pod = build_video_params(&mut params_buf);

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut [params_pod],
        )
        .map_err(|e| format!("failed to connect PipeWire stream: {e}"))?;

    info!("PipeWire stream connected to node {node_id}");

    // Run the main loop, periodically checking stop flag
    let loop_ = mainloop.loop_();
    while !should_stop.load(Ordering::Relaxed) {
        loop_.iterate(std::time::Duration::from_millis(100));
    }

    debug!("PipeWire main loop exiting");
    drop(stream);

    Ok(())
}

use std::os::fd::FromRawFd;

/// Negotiated video format info.
#[derive(Debug, Clone)]
struct VideoFormat {
    width: u32,
    height: u32,
    spa_format: SpaVideoFormat,
}

/// SPA video pixel formats we handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpaVideoFormat {
    BGRx,
    RGBx,
    BGRA,
    RGBA,
    Unknown(u32),
}

/// Parse the negotiated video format from a SPA pod.
fn parse_video_format(param: &pipewire::spa::pod::Pod) -> Result<VideoFormat, String> {
    use pipewire::spa::pod::deserialize::PodDeserializer;
    use pipewire::spa::pod::Value;

    let (_, value) =
        PodDeserializer::deserialize_any_from(param.as_bytes())
            .map_err(|e| format!("pod deserialize error: {e:?}"))?;

    let Value::Object(obj) = value else {
        return Err("expected Object pod".into());
    };

    let mut format_id = 0u32;
    let mut width = 0u32;
    let mut height = 0u32;

    for prop in &obj.properties {
        match prop.key {
            // SPA_FORMAT_VIDEO_format
            0x00020002 => {
                if let Value::Id(id) = &prop.value {
                    format_id = id.0;
                }
            }
            // SPA_FORMAT_VIDEO_size
            0x00020003 => {
                if let Value::Rectangle(rect) = &prop.value {
                    width = rect.width;
                    height = rect.height;
                }
            }
            _ => {}
        }
    }

    if width == 0 || height == 0 {
        return Err("missing size in format".into());
    }

    let spa_format = match format_id {
        7 => SpaVideoFormat::BGRx,    // SPA_VIDEO_FORMAT_BGRx
        8 => SpaVideoFormat::RGBx,    // SPA_VIDEO_FORMAT_RGBx
        9 => SpaVideoFormat::BGRA,    // SPA_VIDEO_FORMAT_BGRA
        10 => SpaVideoFormat::RGBA,   // SPA_VIDEO_FORMAT_RGBA
        other => SpaVideoFormat::Unknown(other),
    };

    Ok(VideoFormat {
        width,
        height,
        spa_format,
    })
}

/// Convert SPA video format pixels to RGBA.
fn convert_spa_to_rgba(src: &[u8], width: u32, height: u32, stride: u32, format: SpaVideoFormat) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    let mut rgba = Vec::with_capacity(pixel_count * 4);

    for y in 0..height {
        let row_start = (y * stride) as usize;
        for x in 0..width {
            let offset = row_start + (x * 4) as usize;
            if offset + 3 >= src.len() {
                rgba.extend_from_slice(&[0, 0, 0, 255]);
                continue;
            }

            match format {
                // BGRx / BGRA: bytes are [B, G, R, A/x] in memory
                SpaVideoFormat::BGRx | SpaVideoFormat::BGRA => {
                    rgba.push(src[offset + 2]); // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset]);     // B
                    rgba.push(255);             // A
                }
                // RGBx / RGBA: bytes are [R, G, B, A/x] in memory
                SpaVideoFormat::RGBx | SpaVideoFormat::RGBA => {
                    rgba.push(src[offset]);     // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset + 2]); // B
                    rgba.push(255);             // A
                }
                // Unknown format — assume BGRx (most common on Linux)
                SpaVideoFormat::Unknown(_) => {
                    rgba.push(src[offset + 2]); // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset]);     // B
                    rgba.push(255);             // A
                }
            }
        }
    }

    rgba
}

/// Build SPA video format parameters pod for stream connection.
fn build_video_params(buf: &mut [u8]) -> &pipewire::spa::pod::Pod {
    use pipewire::spa::pod::serialize::PodSerializer;
    use pipewire::spa::pod::{ChoiceValue, Object, Property, PropertyFlags, Value};
    use pipewire::spa::utils::{
        Choice, ChoiceEnum, ChoiceFlags, Fraction, Id, Rectangle,
    };

    let obj = Value::Object(Object {
        type_: pipewire::spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: pipewire::spa::param::ParamType::EnumFormat.as_raw(),
        properties: vec![
            // mediaType = Video
            Property {
                key: 0x00010001, // SPA_FORMAT_mediaType
                value: Value::Id(Id(2)), // SPA_MEDIA_TYPE_video
                flags: PropertyFlags::empty(),
            },
            // mediaSubtype = Raw
            Property {
                key: 0x00010002, // SPA_FORMAT_mediaSubtype
                value: Value::Id(Id(1)), // SPA_MEDIA_SUBTYPE_raw
                flags: PropertyFlags::empty(),
            },
            // format = BGRx (preferred), with alternatives
            Property {
                key: 0x00020002, // SPA_FORMAT_VIDEO_format
                value: Value::Choice(ChoiceValue::Id(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Enum {
                        default: Id(7),  // BGRx
                        alternatives: vec![
                            Id(7),   // BGRx
                            Id(8),   // RGBx
                            Id(9),   // BGRA
                            Id(10),  // RGBA
                        ],
                    },
                ))),
                flags: PropertyFlags::empty(),
            },
            // size = range from 1x1 to 8192x8192
            Property {
                key: 0x00020003, // SPA_FORMAT_VIDEO_size
                value: Value::Choice(ChoiceValue::Rectangle(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Rectangle { width: 1920, height: 1080 },
                        min: Rectangle { width: 1, height: 1 },
                        max: Rectangle { width: 8192, height: 8192 },
                    },
                ))),
                flags: PropertyFlags::empty(),
            },
            // framerate = range 0/1 to 60/1 (we only need ~1fps but accept anything)
            Property {
                key: 0x00020004, // SPA_FORMAT_VIDEO_framerate
                value: Value::Choice(ChoiceValue::Fraction(Choice(
                    ChoiceFlags::empty(),
                    ChoiceEnum::Range {
                        default: Fraction { num: 1, denom: 1 },
                        min: Fraction { num: 0, denom: 1 },
                        max: Fraction { num: 60, denom: 1 },
                    },
                ))),
                flags: PropertyFlags::empty(),
            },
        ],
    });

    let (result, _) =
        PodSerializer::serialize(std::io::Cursor::new(buf), &obj)
            .expect("failed to serialize video params pod");

    unsafe {
        let ptr = result.into_inner().as_ptr();
        &*(ptr as *const pipewire::spa::pod::Pod)
    }
}
