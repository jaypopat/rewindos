use std::sync::Arc;

use futures_util::StreamExt;
use tracing::{debug, info, warn};
use zbus::Connection;

use crate::capture::gate::CaptureGate;

/// OR the lock signals. Exposed for unit testing.
pub fn combine_lock_state(logind_locked: bool, screensaver_active: bool) -> bool {
    logind_locked || screensaver_active
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Manager",
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1",
    gen_blocking = false
)]
trait LoginManager {
    fn get_session_by_pid(&self, pid: u32) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;
    /// `start == true` just before sleeping, `false` just after resuming.
    #[zbus(signal)]
    fn prepare_for_sleep(&self, start: bool) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.login1.Session",
    default_service = "org.freedesktop.login1",
    gen_blocking = false
)]
trait LoginSession {
    #[zbus(property)]
    fn locked_hint(&self) -> zbus::Result<bool>;
    #[zbus(signal)]
    fn lock(&self) -> zbus::Result<()>;
    #[zbus(signal)]
    fn unlock(&self) -> zbus::Result<()>;
}

#[zbus::proxy(
    interface = "org.freedesktop.ScreenSaver",
    default_service = "org.freedesktop.ScreenSaver",
    default_path = "/org/freedesktop/ScreenSaver",
    gen_blocking = false
)]
trait ScreenSaver {
    fn get_active(&self) -> zbus::Result<bool>;
    #[zbus(signal)]
    fn active_changed(&self, active: bool) -> zbus::Result<()>;
}

/// Spawn the lock watcher. Pauses capture while the session is locked.
///
/// FAIL-OPEN: if no lock source is reachable, `lock_blocked` stays false — we
/// never brick capture on undetectable lock. This is the OPPOSITE default from
/// the privacy gate (which fails CLOSED). The asymmetry is intentional — see the
/// capture-integrity spec. Do not align the two.
pub fn spawn_lock_watcher(gate: Arc<CaptureGate>, system_conn: Connection, session_conn: Connection) {
    tokio::spawn(async move {
        if let Err(e) = run(gate, system_conn, session_conn).await {
            warn!(error = %e, "lock watcher unavailable; capture will not auto-pause on lock");
        }
    });
}

async fn run(
    gate: Arc<CaptureGate>,
    system_conn: Connection,
    session_conn: Connection,
) -> zbus::Result<()> {
    // --- logind (system bus) ---
    let mgr = LoginManagerProxy::new(&system_conn).await?;
    let session_path = mgr.get_session_by_pid(std::process::id()).await?;
    let session = LoginSessionProxy::builder(&system_conn)
        .path(session_path)?
        .build()
        .await?;

    let mut logind_locked = session.locked_hint().await.unwrap_or(false);

    // --- screensaver (session bus), best-effort ---
    let screensaver = ScreenSaverProxy::new(&session_conn).await.ok();
    let mut ss_active = match &screensaver {
        Some(p) => p.get_active().await.unwrap_or(false),
        None => false,
    };

    gate.set_lock_blocked(combine_lock_state(logind_locked, ss_active));
    info!(logind_locked, ss_active, "lock watcher started");

    let mut locked_changes = session.receive_locked_hint_changed().await;
    let mut lock_stream = session.receive_lock().await?;
    let mut unlock_stream = session.receive_unlock().await?;
    // Resume hook: rebuild the capture stream after the machine wakes, since the
    // compositor tears down the screencast on suspend. Best-effort.
    let mut sleep_stream = mgr.receive_prepare_for_sleep().await?;
    let mut ss_stream = match &screensaver {
        Some(p) => Some(p.receive_active_changed().await?),
        None => None,
    };

    loop {
        tokio::select! {
            Some(change) = locked_changes.next() => {
                if let Ok(v) = change.get().await { logind_locked = v; }
            }
            Some(_) = lock_stream.next() => { logind_locked = true; }
            Some(_) = unlock_stream.next() => { logind_locked = false; }
            Some(sig) = sleep_stream.next() => {
                if let Ok(args) = sig.args() {
                    if !args.start {
                        info!("resumed from sleep; requesting capture stream reconnect");
                        gate.request_reconnect();
                    }
                }
            }
            Some(sig) = async { match ss_stream.as_mut() { Some(s) => s.next().await, None => None } } => {
                if let Ok(args) = sig.args() { ss_active = args.active; }
            }
            else => break,
        }
        let locked = combine_lock_state(logind_locked, ss_active);
        debug!(logind_locked, ss_active, locked, "lock state changed");
        gate.set_lock_blocked(locked);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::combine_lock_state;

    #[test]
    fn locked_if_either_source_locked() {
        assert!(!combine_lock_state(false, false));
        assert!(combine_lock_state(true, false));
        assert!(combine_lock_state(false, true));
        assert!(combine_lock_state(true, true));
    }
}
