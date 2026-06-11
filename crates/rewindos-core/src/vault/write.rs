use crate::config::VaultExportConfig;
use crate::db::Database;
use crate::error::Result;
use crate::summary::{self, DigestInput};
use crate::vault::{
    emit_logseq::LogseqEmitter, emit_obsidian::ObsidianEmitter, gather::DayMemory, Emitter,
    VaultFormat,
};
use std::path::Path;

pub struct ExportOutcome {
    pub wrote: bool,
    pub recap_is_ai: bool,
}

/// Gather → resolve recap (cached-or-digest; the daemon layers the async AI tier
/// itself and calls write_memory directly) → emit → write. Idempotent. Skips
/// empty days.
pub fn export_day(
    db: &Database,
    cfg: &VaultExportConfig,
    date_key: &str,
    day_start: i64,
    day_end: i64,
    capture_interval_secs: i64,
) -> Result<ExportOutcome> {
    if !cfg.enabled || cfg.vault_path.is_empty() {
        return Ok(ExportOutcome { wrote: false, recap_is_ai: false });
    }
    let mut mem = DayMemory::for_date(
        db,
        date_key,
        day_start,
        day_end,
        cfg.max_moments,
        capture_interval_secs,
    )?;
    if mem.is_empty() {
        return Ok(ExportOutcome { wrote: false, recap_is_ai: false });
    }

    let cached = db.get_daily_summary_cache(date_key)?.and_then(|c| c.summary_text);
    let digest = DigestInput {
        on_screen_secs: mem.stats.on_screen_secs,
        peak_hour: mem.stats.peak_hour,
        app_minutes: mem.stats.app_minutes.clone(),
        meeting_count: mem.meetings.len(),
    };
    let (recap, recap_is_ai) = match cached {
        Some(c) if !c.trim().is_empty() => (c, true),
        _ => (summary::build_digest(&digest), false),
    };
    mem.recap = Some(recap);

    write_memory(cfg, &mem)?;
    Ok(ExportOutcome { wrote: true, recap_is_ai })
}

/// Prune sections NOT listed in `sections` (journal | summary | meetings |
/// moments | stats). Runs at write time so the daemon's direct write_memory
/// path is covered too; the is_empty/skip-day check stays based on unpruned data.
fn apply_sections(mem: &mut DayMemory, sections: &[String]) {
    let has = |name: &str| sections.iter().any(|s| s == name);
    if !has("journal") {
        mem.journal_text = None;
    }
    if !has("summary") {
        mem.recap = None;
    }
    if !has("meetings") {
        mem.meetings.clear();
    }
    if !has("moments") {
        mem.moments.clear();
    }
    if !has("stats") {
        mem.stats.on_screen_secs = 0;
        mem.stats.peak_hour = None;
        mem.stats.app_minutes.clear();
        mem.stats.todos.clear();
    }
}

/// Render with the configured emitter and write files. Separated so the daemon
/// can set an AI recap on `mem` first, then call this.
pub fn write_memory(cfg: &VaultExportConfig, mem: &DayMemory) -> Result<()> {
    let mut mem = mem.clone();
    apply_sections(&mut mem, &cfg.sections);
    // Never write an empty companion: section pruning can hollow out a day
    // that gather considered non-empty (e.g. journal-only day with
    // sections = ["stats"]).
    if mem.is_empty() {
        return Ok(());
    }
    let mem = &mem;
    let format = VaultFormat::parse(&cfg.format);
    let rendered = match format {
        VaultFormat::Obsidian => {
            ObsidianEmitter.render(mem, &cfg.companion_dir, cfg.copy_thumbnails)
        }
        VaultFormat::Logseq => {
            LogseqEmitter.render(mem, &cfg.companion_dir, cfg.copy_thumbnails)
        }
    };
    let root = Path::new(&cfg.vault_path);

    // companion note path differs per format
    let note_path = match format {
        VaultFormat::Obsidian => {
            root.join(&cfg.companion_dir).join(format!("{}.md", mem.date_key))
        }
        // Logseq stores namespaced pages as FLAT files directly under pages/,
        // with the namespace separator encoded in the filename. The modern
        // default (`:file/name-format :triple-lowbar`, Logseq >= 0.8.9) maps
        // page "a/b" to "a___b.md". The page NAME stays
        // "<companion_dir>/<date>", so embeds like
        // {{embed [[_rewindos/2026-06-10]]}} resolve unchanged, and the flat
        // location keeps the emitters' `../assets/` image refs valid. Legacy
        // graphs still on the url-encoded format (`%2F`) may need the file
        // renamed by hand.
        VaultFormat::Logseq => root
            .join("pages")
            .join(format!("{}___{}.md", cfg.companion_dir, mem.date_key)),
    };
    if let Some(parent) = note_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // atomic write: tmp name derives from the final filename (avoids any
    // extension-replacement surprises and collisions in the shared pages/ dir)
    let tmp = note_path.with_file_name(match note_path.file_name() {
        Some(n) => format!("{}.tmp", n.to_string_lossy()),
        None => format!("{}.md.tmp", mem.date_key),
    });
    std::fs::write(&tmp, rendered.markdown.as_bytes())?;
    std::fs::rename(&tmp, &note_path)?;

    // copy thumbnails — best-effort: a missing source (pruned) shouldn't fail the write
    for t in &rendered.thumbnails {
        let dest = root.join(&t.dest_rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Err(e) = std::fs::copy(&t.src, &dest) {
            tracing::warn!(src = %t.src.display(), dest = %dest.display(), "vault thumbnail copy failed: {e}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn writes_companion_and_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_journal_entry(&crate::schema::UpsertJournalEntry {
            date: "2026-06-10".into(),
            content: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}"#.into(),
        }).unwrap();
        let vault = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::VaultExportConfig::default();
        cfg.enabled = true;
        cfg.format = "obsidian".into();
        cfg.vault_path = vault.path().to_string_lossy().into();

        let day_start = 1_780_000_000;
        let res = export_day(&db, &cfg, "2026-06-10", day_start, day_start + 86400, 5).unwrap();
        assert!(res.wrote, "should write a non-empty day");
        let note = vault.path().join("_rewindos/2026-06-10.md");
        assert!(note.exists());
        let body = std::fs::read_to_string(&note).unwrap();
        assert!(body.contains("hello"));

        // idempotent: second run overwrites, no error, same content
        export_day(&db, &cfg, "2026-06-10", day_start, day_start + 86400, 5).unwrap();
        assert_eq!(std::fs::read_to_string(&note).unwrap(), body);
    }

    #[test]
    fn logseq_note_is_flat_triple_lowbar_under_pages() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_journal_entry(&crate::schema::UpsertJournalEntry {
            date: "2026-06-10".into(),
            content: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}"#.into(),
        }).unwrap();
        let vault = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::VaultExportConfig::default();
        cfg.enabled = true;
        cfg.format = "logseq".into();
        cfg.vault_path = vault.path().to_string_lossy().into();

        let day_start = 1_780_000_000;
        let res = export_day(&db, &cfg, "2026-06-10", day_start, day_start + 86400, 5).unwrap();
        assert!(res.wrote);
        // Triple-lowbar convention: namespaced page "_rewindos/2026-06-10" is
        // a flat file under pages/, not a nested directory.
        let flat = vault.path().join("pages/_rewindos___2026-06-10.md");
        assert!(flat.exists(), "flat triple-lowbar page file must exist");
        assert!(
            !vault.path().join("pages/_rewindos/2026-06-10.md").exists(),
            "must not create a nested namespace directory"
        );
        assert!(std::fs::read_to_string(&flat).unwrap().contains("hello"));
    }

    #[test]
    fn empty_day_writes_nothing() {
        let db = Database::open_in_memory().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::VaultExportConfig::default();
        cfg.enabled = true;
        cfg.vault_path = vault.path().to_string_lossy().into();
        let res =
            export_day(&db, &cfg, "2026-06-10", 1_780_000_000, 1_780_000_000 + 86400, 5).unwrap();
        assert!(!res.wrote);
        assert!(!vault.path().join("_rewindos/2026-06-10.md").exists());
    }

    #[test]
    fn sections_config_prunes_unlisted_sections() {
        use crate::vault::gather::{DayMemory, MeetingMemory, StatsMemory};
        let vault = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::VaultExportConfig::default();
        cfg.enabled = true;
        cfg.format = "obsidian".into();
        cfg.vault_path = vault.path().to_string_lossy().into();
        cfg.sections = vec!["journal".into()];

        let mem = DayMemory {
            date_key: "2026-06-10".into(),
            journal_text: Some("only the journal survives".into()),
            recap: Some("a recap".into()),
            meetings: vec![MeetingMemory {
                title: "Standup".into(),
                started_at: 1_780_000_000,
                duration_secs: 720,
                minutes: None,
                transcript: vec![],
            }],
            moments: vec![],
            stats: StatsMemory {
                on_screen_secs: 4 * 3600,
                peak_hour: Some(14),
                app_minutes: vec![("VS Code".into(), 120)],
                todos: vec!["reply to thread".into()],
            },
        };
        write_memory(&cfg, &mem).unwrap();

        let body =
            std::fs::read_to_string(vault.path().join("_rewindos/2026-06-10.md")).unwrap();
        assert!(body.contains("only the journal survives"), "journal kept");
        assert!(!body.contains("## Meetings"), "meetings pruned");
        assert!(!body.contains("## By the numbers"), "stats pruned");
        assert!(!body.contains("## Today"), "recap pruned");
        assert!(!body.contains("## To-dos surfaced"), "todos pruned");
    }

    #[test]
    fn pruned_empty_memory_writes_no_file() {
        use crate::vault::gather::{DayMemory, StatsMemory};
        let vault = tempfile::tempdir().unwrap();
        let mut cfg = crate::config::VaultExportConfig::default();
        cfg.enabled = true;
        cfg.format = "obsidian".into();
        cfg.vault_path = vault.path().to_string_lossy().into();
        // journal-only day, but only "stats" is enabled → pruning empties it
        cfg.sections = vec!["stats".into()];

        let mem = DayMemory {
            date_key: "2026-06-10".into(),
            journal_text: Some("only a journal entry today".into()),
            recap: None,
            meetings: vec![],
            moments: vec![],
            stats: StatsMemory {
                on_screen_secs: 0,
                peak_hour: None,
                app_minutes: vec![],
                todos: vec![],
            },
        };
        write_memory(&cfg, &mem).unwrap();
        assert!(
            !vault.path().join("_rewindos/2026-06-10.md").exists(),
            "an empty pruned memory must not produce a companion note"
        );
    }
}
