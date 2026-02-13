use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use tracing::{debug, info, warn};
use wayland_client::protocol::wl_registry;
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1::{self, ZwlrForeignToplevelHandleV1},
    zwlr_foreign_toplevel_manager_v1::{self, ZwlrForeignToplevelManagerV1},
};

use super::{non_empty, WindowInfo, WindowInfoError, WindowInfoProvider};

/// Window info provider using the wlr-foreign-toplevel-management protocol.
///
/// Supported by Sway, Hyprland, COSMIC, wlroots compositors, and recent Mutter.
/// Runs the Wayland event loop on a dedicated std::thread (Wayland objects are !Send).
pub struct WlrForeignToplevelProvider {
    current: Arc<RwLock<WindowInfo>>,
    stop_flag: Arc<AtomicBool>,
    thread: std::sync::Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl WlrForeignToplevelProvider {
    pub fn new() -> Self {
        Self {
            current: Arc::new(RwLock::new(WindowInfo::default())),
            stop_flag: Arc::new(AtomicBool::new(false)),
            thread: std::sync::Mutex::new(None),
        }
    }
}

#[async_trait]
impl WindowInfoProvider for WlrForeignToplevelProvider {
    fn name(&self) -> &'static str {
        "wlr-foreign-toplevel"
    }

    async fn probe(&self) -> bool {
        // Try connecting and checking the registry for the manager global
        let conn = match Connection::connect_to_env() {
            Ok(c) => c,
            Err(_) => return false,
        };

        let display = conn.display();
        let mut event_queue = conn.new_event_queue();
        let qh = event_queue.handle();

        let mut probe_state = ProbeState { found: false };
        let _registry = display.get_registry(&qh, ());

        // Do a few roundtrips to receive globals
        for _ in 0..3 {
            if event_queue.roundtrip(&mut probe_state).is_err() {
                return false;
            }
            if probe_state.found {
                return true;
            }
        }

        false
    }

    async fn start(&self) -> Result<(), WindowInfoError> {
        self.stop_flag.store(false, Ordering::Release);

        let current = self.current.clone();
        let stop_flag = self.stop_flag.clone();

        let handle = std::thread::Builder::new()
            .name("rewindos-wlr-toplevel".into())
            .spawn(move || {
                if let Err(e) = run_toplevel_loop(current, stop_flag) {
                    warn!("wlr-foreign-toplevel thread exited with error: {e}");
                }
            })
            .map_err(|e| {
                WindowInfoError::Provider(format!("failed to spawn Wayland thread: {e}"))
            })?;

        *self.thread.lock().unwrap() = Some(handle);
        info!("wlr-foreign-toplevel window tracking started");
        Ok(())
    }

    fn current(&self) -> WindowInfo {
        self.current.read().unwrap().clone()
    }

    async fn stop(&self) -> Result<(), WindowInfoError> {
        self.stop_flag.store(true, Ordering::Release);

        let handle = self.thread.lock().unwrap().take();
        if let Some(handle) = handle {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            })
            .await;
        }

        info!("wlr-foreign-toplevel window tracking stopped");
        Ok(())
    }
}

/// Dispatch state for the Wayland event loop thread.
struct ToplevelState {
    current: Arc<RwLock<WindowInfo>>,
    /// Manager global, bound once from registry.
    manager: Option<ZwlrForeignToplevelManagerV1>,
    /// Per-handle pending state, keyed by handle id.
    handles: Vec<HandleState>,
}

struct HandleState {
    handle: ZwlrForeignToplevelHandleV1,
    app_id: Option<String>,
    title: Option<String>,
    activated: bool,
}

fn run_toplevel_loop(
    current: Arc<RwLock<WindowInfo>>,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let conn =
        Connection::connect_to_env().map_err(|e| format!("Wayland connect failed: {e}"))?;

    let display = conn.display();
    let mut event_queue = conn.new_event_queue();
    let qh = event_queue.handle();

    let mut state = ToplevelState {
        current,
        manager: None,
        handles: Vec::new(),
    };

    let _registry = display.get_registry(&qh, ());

    // Initial roundtrip to bind globals
    event_queue
        .roundtrip(&mut state)
        .map_err(|e| format!("initial roundtrip failed: {e}"))?;

    if state.manager.is_none() {
        return Err(
            "zwlr_foreign_toplevel_manager_v1 not found in compositor globals".to_string(),
        );
    }

    info!("wlr-foreign-toplevel manager bound, listening for window events");

    // Event loop: dispatch with a short timeout so we can check the stop flag
    while !stop_flag.load(Ordering::Relaxed) {
        // Flush outgoing requests
        if let Err(e) = event_queue.flush() {
            warn!("Wayland flush error: {e}");
            break;
        }

        // Prepare to read from the Wayland socket with a timeout
        match conn.prepare_read() {
            Some(guard) => {
                // Use poll to wait for data with a timeout
                let fd = guard.connection_fd();
                let mut pollfd = [nix::poll::PollFd::new(fd, nix::poll::PollFlags::POLLIN)];
                match nix::poll::poll(&mut pollfd, nix::poll::PollTimeout::from(100u16)) {
                    Ok(n) if n > 0 => {
                        if let Err(e) = guard.read() {
                            warn!("Wayland read error: {e}");
                            break;
                        }
                    }
                    Ok(_) => {
                        // Timeout, no data — dropping guard cancels the read
                        drop(guard);
                    }
                    Err(nix::errno::Errno::EINTR) => {
                        drop(guard);
                        continue;
                    }
                    Err(e) => {
                        warn!("poll error: {e}");
                        drop(guard);
                        break;
                    }
                }
            }
            None => {
                // Events already queued, no read needed
            }
        }

        // Dispatch any pending events
        if let Err(e) = event_queue.dispatch_pending(&mut state) {
            warn!("Wayland dispatch error: {e}");
            break;
        }
    }

    // Clean up: destroy handles and stop manager
    for h in &state.handles {
        h.handle.destroy();
    }
    if let Some(ref manager) = state.manager {
        manager.stop();
    }

    debug!("wlr-foreign-toplevel event loop exiting");
    Ok(())
}

// -- Probe-only state (used in probe()) --

struct ProbeState {
    found: bool,
}

impl Dispatch<wl_registry::WlRegistry, ()> for ProbeState {
    fn event(
        state: &mut Self,
        _proxy: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global { interface, .. } = event {
            if interface == "zwlr_foreign_toplevel_manager_v1" {
                state.found = true;
            }
        }
    }
}

// -- Main dispatch implementations --

impl Dispatch<wl_registry::WlRegistry, ()> for ToplevelState {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            if interface == "zwlr_foreign_toplevel_manager_v1" {
                let bind_version = version.min(3);
                let manager = registry.bind::<ZwlrForeignToplevelManagerV1, _, _>(
                    name,
                    bind_version,
                    qh,
                    (),
                );
                debug!(version = bind_version, "bound zwlr_foreign_toplevel_manager_v1");
                state.manager = Some(manager);
            }
        }
    }
}

impl Dispatch<ZwlrForeignToplevelManagerV1, ()> for ToplevelState {
    fn event(
        state: &mut Self,
        _proxy: &ZwlrForeignToplevelManagerV1,
        event: zwlr_foreign_toplevel_manager_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_foreign_toplevel_manager_v1::Event::Toplevel { toplevel } => {
                debug!("new toplevel handle");
                state.handles.push(HandleState {
                    handle: toplevel,
                    app_id: None,
                    title: None,
                    activated: false,
                });
            }
            zwlr_foreign_toplevel_manager_v1::Event::Finished => {
                info!("toplevel manager finished");
            }
            _ => {}
        }
    }
}

impl Dispatch<ZwlrForeignToplevelHandleV1, ()> for ToplevelState {
    fn event(
        state: &mut Self,
        proxy: &ZwlrForeignToplevelHandleV1,
        event: zwlr_foreign_toplevel_handle_v1::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        let Some(handle_state) = state.handles.iter_mut().find(|h| h.handle == *proxy) else {
            return;
        };

        match event {
            zwlr_foreign_toplevel_handle_v1::Event::Title { title } => {
                handle_state.title = non_empty(title);
            }
            zwlr_foreign_toplevel_handle_v1::Event::AppId { app_id } => {
                handle_state.app_id = non_empty(app_id);
            }
            zwlr_foreign_toplevel_handle_v1::Event::State { state: raw_state } => {
                // State is an array of u32 values encoded as raw bytes (little-endian)
                handle_state.activated = raw_state
                    .chunks_exact(4)
                    .any(|chunk| {
                        let val = u32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                        val == zwlr_foreign_toplevel_handle_v1::State::Activated as u32
                    });
            }
            zwlr_foreign_toplevel_handle_v1::Event::Done => {
                // Atomic update complete — if this handle is activated, publish it
                if handle_state.activated {
                    let info = WindowInfo {
                        app_name: handle_state.app_id.clone(),
                        window_title: handle_state.title.clone(),
                        window_class: handle_state.app_id.clone(),
                    };
                    debug!(
                        app = ?info.app_name,
                        title = ?info.window_title,
                        "active window updated via wlr-foreign-toplevel"
                    );
                    *state.current.write().unwrap() = info;
                }
            }
            zwlr_foreign_toplevel_handle_v1::Event::Closed => {
                // Destroy protocol object first, then remove from tracking list
                proxy.destroy();
                state.handles.retain(|h| h.handle != *proxy);
            }
            _ => {}
        }
    }
}
