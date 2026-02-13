use std::collections::HashMap;
use std::os::fd::{AsFd, AsRawFd};

use async_trait::async_trait;
use nix::unistd;
use rewindos_core::schema::RawFrame;
use tracing::{debug, info, warn};
use zbus::zvariant::{Fd, OwnedValue, Value};
use zbus::Connection;

use super::CaptureError;

/// KWin ScreenShot2 D-Bus capture backend.
pub struct KwinCaptureBackend {
    conn: Connection,
}

impl KwinCaptureBackend {
    pub fn new(conn: Connection) -> Self {
        Self { conn }
    }
}

#[async_trait]
impl super::CaptureBackend for KwinCaptureBackend {
    fn name(&self) -> &'static str {
        "KWin ScreenShot2"
    }

    async fn initialize(&mut self) -> Result<(), CaptureError> {
        if !is_available(&self.conn).await {
            return Err(CaptureError::Unavailable(
                "KWin ScreenShot2 D-Bus interface not found".into(),
            ));
        }
        Ok(())
    }

    async fn capture_frame(&mut self) -> Result<RawFrame, CaptureError> {
        capture_workspace(&self.conn).await
    }

    async fn shutdown(&mut self) -> Result<(), CaptureError> {
        Ok(())
    }
}

/// Capture a full workspace screenshot via KWin's `org.kde.KWin.ScreenShot2` D-Bus API.
///
/// KWin writes raw pixel data to a pipe and returns metadata (width, height, stride, format).
/// We read the raw pixels, convert from QImage format (ARGB32/RGB32) to RGBA, and return a `RawFrame`.
pub async fn capture_workspace(conn: &Connection) -> Result<RawFrame, CaptureError> {
    // Create a Unix pipe: KWin writes to write_fd, we read from read_fd
    let (read_fd, write_fd) =
        unistd::pipe().map_err(|e| CaptureError::KWin(format!("failed to create pipe: {e}")))?;

    // Build options dict for CaptureWorkspace
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("include-cursor", Value::Bool(false));
    options.insert("native-resolution", Value::Bool(true));

    // Wrap fd for D-Bus (zvariant::Fd implements Type + Serialize for fd passing)
    let dbus_fd = Fd::from(write_fd.as_fd());

    // Call org.kde.KWin.ScreenShot2.CaptureWorkspace(options, pipe) -> metadata dict
    // Signature: (a{sv}, h) — options dict first, then file descriptor
    let reply = conn
        .call_method(
            Some("org.kde.KWin"),
            "/org/kde/KWin/ScreenShot2",
            Some("org.kde.KWin.ScreenShot2"),
            "CaptureWorkspace",
            &(options, dbus_fd),
        )
        .await
        .map_err(|e| CaptureError::KWin(format!("CaptureWorkspace D-Bus call failed: {e}")))?;

    // Close write end — KWin has it, we only need the read end
    drop(write_fd);

    // Parse metadata from reply
    let metadata: HashMap<String, OwnedValue> = reply
        .body()
        .deserialize()
        .map_err(|e| CaptureError::KWin(format!("failed to deserialize metadata: {e}")))?;

    let width = meta_u32(&metadata, "width")
        .ok_or_else(|| CaptureError::KWin("missing 'width' in metadata".into()))?;
    let height = meta_u32(&metadata, "height")
        .ok_or_else(|| CaptureError::KWin("missing 'height' in metadata".into()))?;
    let stride = meta_u32(&metadata, "stride")
        .ok_or_else(|| CaptureError::KWin("missing 'stride' in metadata".into()))?;
    let format = meta_u32(&metadata, "format").unwrap_or(QImageFormat::ARGB32 as u32);

    debug!(width, height, stride, format, "KWin screenshot metadata");

    // Read raw pixel data from pipe (blocking I/O — offload to blocking thread)
    let expected_size = (stride * height) as usize;
    let raw_pixels = tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; expected_size];
        let mut total_read = 0;
        while total_read < expected_size {
            match unistd::read(read_fd.as_raw_fd(), &mut buf[total_read..]) {
                Ok(0) => break, // EOF
                Ok(n) => total_read += n,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(e) => return Err(format!("pipe read error: {e}")),
            }
        }
        buf.truncate(total_read);
        Ok(buf)
    })
    .await
    .map_err(|e| CaptureError::KWin(format!("blocking read task panicked: {e}")))?
    .map_err(CaptureError::KWin)?;

    if raw_pixels.len() < expected_size {
        return Err(CaptureError::KWin(format!(
            "incomplete read: got {} bytes, expected {}",
            raw_pixels.len(),
            expected_size
        )));
    }

    // Convert QImage pixel format to RGBA
    let rgba = convert_qimage_to_rgba(&raw_pixels, width, height, stride, format);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    Ok(RawFrame {
        pixels: rgba,
        width,
        height,
        timestamp,
        app_name: None,
        window_title: None,
        window_class: None,
    })
}

/// Check if KWin ScreenShot2 D-Bus interface is available.
pub async fn is_available(conn: &Connection) -> bool {
    let result = conn
        .call_method(
            Some("org.kde.KWin"),
            "/org/kde/KWin/ScreenShot2",
            Some("org.freedesktop.DBus.Introspectable"),
            "Introspect",
            &(),
        )
        .await;

    match result {
        Ok(_) => {
            info!("KWin ScreenShot2 D-Bus interface is available");
            true
        }
        Err(e) => {
            warn!("KWin ScreenShot2 not available: {e}");
            false
        }
    }
}

// -- QImage format constants (matches Qt's QImage::Format enum) --

#[allow(non_camel_case_types, dead_code)]
#[repr(u32)]
enum QImageFormat {
    RGB32 = 4,
    ARGB32 = 5,
    ARGB32_Premultiplied = 6,
    RGBX8888 = 25,
    RGBA8888 = 26,
}

/// Convert QImage raw pixels to RGBA byte order.
fn convert_qimage_to_rgba(
    src: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
) -> Vec<u8> {
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
                // RGB32 / ARGB32 / ARGB32_Premultiplied: BGRA in memory on little-endian
                f if f == QImageFormat::RGB32 as u32
                    || f == QImageFormat::ARGB32 as u32
                    || f == QImageFormat::ARGB32_Premultiplied as u32 =>
                {
                    rgba.push(src[offset + 2]); // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset]); // B
                    rgba.push(255); // A (force opaque)
                }
                // RGBX8888 / RGBA8888: memory layout is RGBA
                f if f == QImageFormat::RGBX8888 as u32 || f == QImageFormat::RGBA8888 as u32 => {
                    rgba.push(src[offset]); // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset + 2]); // B
                    rgba.push(255); // A
                }
                // Unknown format — assume BGRA (most common on KDE/Wayland)
                _ => {
                    rgba.push(src[offset + 2]); // R
                    rgba.push(src[offset + 1]); // G
                    rgba.push(src[offset]); // B
                    rgba.push(255); // A
                }
            }
        }
    }

    rgba
}

/// Extract a u32 value from the KWin metadata dict.
fn meta_u32(meta: &HashMap<String, OwnedValue>, key: &str) -> Option<u32> {
    let val = meta.get(key)?;

    if let Ok(v) = <u32>::try_from(val) {
        return Some(v);
    }
    if let Ok(v) = <i32>::try_from(val) {
        return Some(v as u32);
    }
    if let Ok(v) = <u64>::try_from(val) {
        return Some(v as u32);
    }

    None
}
