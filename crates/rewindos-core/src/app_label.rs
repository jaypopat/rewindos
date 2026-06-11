//! Resolve raw window-system app identifiers (reverse-DNS app IDs, WM_CLASS,
//! lowercase resource names) to human-friendly display names via installed
//! freedesktop .desktop entries, with a heuristic fallback.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::db::Database;
use crate::error::Result;

/// One parsed .desktop entry (the `[Desktop Entry]` group only).
struct DesktopEntry {
    basename: String, // file name without .desktop
    name: String,     // unlocalized Name=
    wm_class: Option<String>,
    no_display: bool,
}

pub struct AppLabelResolver {
    /// exact basename -> Name (includes NoDisplay entries)
    by_exact_id: HashMap<String, String>,
    /// lowercase basename -> Name (includes NoDisplay entries)
    by_lower_id: HashMap<String, String>,
    /// lowercase StartupWMClass -> Name (EXCLUDES NoDisplay entries)
    by_class: HashMap<String, String>,
    /// raw -> resolved memo
    cache: Mutex<HashMap<String, String>>,
}

impl AppLabelResolver {
    /// Scan the given directories for *.desktop files (sorted for determinism;
    /// first writer wins so earlier dirs take precedence).
    pub fn from_dirs(dirs: &[PathBuf]) -> Self {
        let mut by_exact_id = HashMap::new();
        let mut by_lower_id = HashMap::new();
        let mut by_class = HashMap::new();
        for dir in dirs {
            let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.filter_map(|e| e.ok().map(|e| e.path()))
                        .filter(|p| p.extension().is_some_and(|e| e == "desktop"))
                        .collect()
                })
                .unwrap_or_default();
            files.sort();
            for path in files {
                if let Some(entry) = parse_desktop_file(&path) {
                    by_exact_id
                        .entry(entry.basename.clone())
                        .or_insert_with(|| entry.name.clone());
                    by_lower_id
                        .entry(entry.basename.to_lowercase())
                        .or_insert_with(|| entry.name.clone());
                    if !entry.no_display {
                        if let Some(class) = &entry.wm_class {
                            by_class
                                .entry(class.to_lowercase())
                                .or_insert_with(|| entry.name.clone());
                        }
                    }
                }
            }
        }
        Self { by_exact_id, by_lower_id, by_class, cache: Mutex::new(HashMap::new()) }
    }

    /// Production constructor: XDG data dirs + flatpak exports.
    pub fn system() -> Self {
        let mut dirs = Vec::new();
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local/share/applications"));
            dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
        }
        let xdg = std::env::var("XDG_DATA_DIRS")
            .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
        for d in xdg.split(':').filter(|d| !d.is_empty()) {
            dirs.push(Path::new(d).join("applications"));
        }
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
        Self::from_dirs(&dirs)
    }

    /// Resolve a raw identifier to a display name. Never fails; empty input
    /// passes through.
    pub fn resolve(&self, raw: &str) -> String {
        if raw.is_empty() {
            return String::new();
        }
        if let Some(hit) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(raw) {
            return hit.clone();
        }
        let resolved = self
            .by_exact_id
            .get(raw)
            .or_else(|| self.by_lower_id.get(&raw.to_lowercase()))
            .or_else(|| self.by_class.get(&raw.to_lowercase()))
            .cloned()
            .unwrap_or_else(|| fallback_label(raw));
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(raw.to_string(), resolved.clone());
        resolved
    }
}

/// Last reverse-DNS segment if the id looks reverse-DNS (>= 2 dots),
/// then first-letter title-case.
fn fallback_label(raw: &str) -> String {
    let base = if raw.matches('.').count() >= 2 {
        raw.rsplit('.').next().unwrap_or(raw)
    } else {
        raw
    };
    let mut chars = base.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

pub const BACKFILL_FLAG: &str = "app_label_backfill_done";

/// One-time rename of historical screenshot app_names to display names.
/// Guarded by a daemon_state flag; returns the number of distinct names renamed.
pub fn backfill_app_labels(db: &Database, resolver: &AppLabelResolver) -> Result<usize> {
    if db.get_daemon_state(BACKFILL_FLAG)?.as_deref() == Some("1") {
        return Ok(0);
    }
    let mut renamed = 0usize;
    for raw in db.distinct_app_names()? {
        let resolved = resolver.resolve(&raw);
        if resolved != raw {
            db.rename_app(&raw, &resolved)?;
            renamed += 1;
        }
    }
    db.set_daemon_state(BACKFILL_FLAG, "1")?;
    Ok(renamed)
}

/// Minimal .desktop parser: unlocalized Name=, StartupWMClass=, NoDisplay=
/// from the [Desktop Entry] group only.
fn parse_desktop_file(path: &Path) -> Option<DesktopEntry> {
    let content = std::fs::read_to_string(path).ok()?;
    let basename = path.file_stem()?.to_str()?.to_string();
    let mut in_entry_group = false;
    let mut name = None;
    let mut wm_class = None;
    let mut no_display = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            if in_entry_group {
                break; // left [Desktop Entry]
            }
            in_entry_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry_group {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            name.get_or_insert_with(|| v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("StartupWMClass=") {
            wm_class = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("NoDisplay=") {
            no_display = v.trim().eq_ignore_ascii_case("true");
        }
    }
    Some(DesktopEntry { basename, name: name?, wm_class, no_display })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("org.kde.dolphin.desktop"),
            "[Desktop Entry]\nName=Dolphin\nType=Application\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("code.desktop"),
            "[Desktop Entry]\nName=Visual Studio Code\nStartupWMClass=Code\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("firefox.desktop"),
            "[Desktop Entry]\nName=Firefox\nStartupWMClass=Navigator\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("org.hidden.helper.desktop"),
            "[Desktop Entry]\nName=Hidden Helper\nNoDisplay=true\nStartupWMClass=helperclass\n",
        )
        .unwrap();
        // localized Name lines must be ignored
        std::fs::write(
            dir.path().join("org.gnome.Nautilus.desktop"),
            "[Desktop Entry]\nName[de]=Dateien\nName=Files\nType=Application\n[Desktop Action new-window]\nName=New Window\n",
        )
        .unwrap();
        dir
    }

    fn resolver() -> AppLabelResolver {
        let dir = fixture_dir();
        let r = AppLabelResolver::from_dirs(&[dir.path().to_path_buf()]);
        // TempDir must outlive the scan, which happens in from_dirs — safe to drop after.
        drop(dir);
        r
    }

    #[test]
    fn exact_basename_match() {
        assert_eq!(resolver().resolve("org.kde.dolphin"), "Dolphin");
    }

    #[test]
    fn case_insensitive_basename_match() {
        assert_eq!(resolver().resolve("Code"), "Visual Studio Code");
        assert_eq!(resolver().resolve("code"), "Visual Studio Code");
    }

    #[test]
    fn startup_wm_class_match() {
        assert_eq!(resolver().resolve("Navigator"), "Firefox");
        assert_eq!(resolver().resolve("navigator"), "Firefox");
    }

    #[test]
    fn nodisplay_kept_for_id_but_skipped_for_class() {
        let r = resolver();
        assert_eq!(r.resolve("org.hidden.helper"), "Hidden Helper");
        // class match must skip NoDisplay entries → falls back to title-case
        assert_eq!(r.resolve("helperclass"), "Helperclass");
    }

    #[test]
    fn reverse_dns_fallback_takes_last_segment_titlecased() {
        assert_eq!(resolver().resolve("org.unknown.coolapp"), "Coolapp");
    }

    #[test]
    fn plain_unknown_name_titlecased() {
        assert_eq!(resolver().resolve("zen"), "Zen");
        assert_eq!(resolver().resolve("ksplashqml"), "Ksplashqml");
    }

    #[test]
    fn group_header_ends_desktop_entry_parsing() {
        // org.gnome.Nautilus: the [Desktop Action] Name must not override
        assert_eq!(resolver().resolve("org.gnome.Nautilus"), "Files");
    }

    #[test]
    fn empty_passthrough() {
        assert_eq!(resolver().resolve(""), "");
    }

    #[test]
    fn backfill_renames_once_and_sets_flag() {
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut s = crate::schema::NewScreenshot {
            timestamp: 1000,
            timestamp_ms: 1_000_000,
            app_name: Some("org.kde.dolphin".into()),
            window_title: Some("t".into()),
            window_class: Some("dolphin".into()),
            file_path: "/f/a.webp".into(),
            thumbnail_path: None,
            width: 1,
            height: 1,
            file_size_bytes: 1,
            perceptual_hash: vec![0u8; 8],
        };
        db.insert_screenshot(&s).unwrap();
        s.timestamp = 2000;
        s.app_name = Some("alreadyfine".into());
        db.insert_screenshot(&s).unwrap();

        let r = resolver(); // fixture resolver from this module
        let renamed = backfill_app_labels(&db, &r).unwrap();
        assert_eq!(renamed, 2); // dolphin -> Dolphin, alreadyfine -> Alreadyfine
        let names = db.distinct_app_names().unwrap();
        assert!(names.contains(&"Dolphin".to_string()));
        assert!(names.contains(&"Alreadyfine".to_string()));

        // second run: flag set, no-op
        assert_eq!(backfill_app_labels(&db, &r).unwrap(), 0);
    }
}
