//! Vault export: gather a format-agnostic DayMemory, render it through a
//! per-tool emitter, write it into the user's vault/graph.
pub mod gather;

pub use gather::DayMemory;

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
