//! Vault export: gather a format-agnostic DayMemory, render it through a
//! per-tool emitter, write it into the user's vault/graph.
pub mod emit_logseq;
pub mod emit_obsidian;
pub mod gather;

pub use gather::DayMemory;

// ---------------------------------------------------------------------------
// Shared time-formatting helpers (pub(crate) so emitters can use them).
// ---------------------------------------------------------------------------

/// Unix timestamp → "HHMM" string in local time (e.g. 1435 → "1435").
pub(crate) fn hhmm(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|dt| dt.format("%H%M").to_string())
        .unwrap_or_else(|| "0000".into())
}

/// Unix timestamp → "HH:MM" string in local time (e.g. 1435 → "14:35").
pub(crate) fn hh_mm_label(ts: i64) -> String {
    use chrono::{Local, TimeZone};
    Local
        .timestamp_opt(ts, 0)
        .single()
        .map(|dt| dt.format("%H:%M").to_string())
        .unwrap_or_else(|| "00:00".into())
}

/// Duration in seconds → human-friendly label (e.g. 3661 → "1h01m", 90 → "1h30m", 45 → "45m").
pub(crate) fn dur_label(secs: i64) -> String {
    let m = secs / 60;
    if m >= 60 {
        format!("{}h{:02}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

/// Milliseconds → "M:SS" string (e.g. 65_000 → "1:05").
pub(crate) fn mmss(ms: i64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Which note app we're emitting for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultFormat {
    Obsidian,
    Logseq,
}

impl VaultFormat {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "logseq" => VaultFormat::Logseq,
            _ => VaultFormat::Obsidian, // unknown values fall back to Obsidian
        }
    }
}

/// A thumbnail to copy into the vault/graph.
pub struct ThumbnailCopy {
    /// Absolute source path of the existing thumbnail in ~/.rewindos.
    pub src: std::path::PathBuf,
    /// Destination path RELATIVE to the vault root.
    pub dest_rel: std::path::PathBuf,
}

/// The output of an emitter: the markdown body + the thumbnails to copy.
pub struct RenderedDay {
    pub markdown: String,
    pub thumbnails: Vec<ThumbnailCopy>,
}

/// Emitters turn a DayMemory + config into a RenderedDay.
pub trait Emitter {
    fn render(&self, mem: &DayMemory, companion_dir: &str, copy_thumbnails: bool) -> RenderedDay;
}
