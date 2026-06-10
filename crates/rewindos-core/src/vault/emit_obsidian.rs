use crate::vault::{
    gather::DayMemory,
    continuation_safe, dur_label, hh_mm_label, hhmm, mmss, Emitter, RenderedDay, ThumbnailCopy,
};
use std::path::PathBuf;

pub struct ObsidianEmitter;

impl Emitter for ObsidianEmitter {
    fn render(&self, mem: &DayMemory, companion_dir: &str, copy_thumbnails: bool) -> RenderedDay {
        let mut md = String::new();
        let mut thumbnails: Vec<ThumbnailCopy> = Vec::new();

        // --- frontmatter (always present) ---
        md.push_str("---\n");
        md.push_str(&format!("date: {}\n", mem.date_key));
        md.push_str("source: rewindos\n");
        md.push_str("tags: [rewindos/daily]\n");
        md.push_str("---\n");

        // --- Journal ---
        if let Some(text) = &mem.journal_text {
            md.push_str("## Your note\n");
            md.push_str(text);
            md.push('\n');
            md.push('\n');
        }

        // --- Recap ---
        if let Some(recap) = &mem.recap {
            md.push_str("## Today\n");
            md.push_str(recap);
            md.push('\n');
            md.push('\n');
        }

        // --- Meetings ---
        if !mem.meetings.is_empty() {
            md.push_str("## Meetings\n");
            for m in &mem.meetings {
                let time = hh_mm_label(m.started_at);
                let dur = dur_label(m.duration_secs);
                md.push_str(&format!("> [!note]- {} — {} · {}\n", m.title, time, dur));
                if let Some(mins) = &m.minutes {
                    md.push_str(&format!("> minutes: {}\n", continuation_safe(mins, "> ")));
                }
                for seg in &m.transcript {
                    md.push_str(&format!(
                        "> **{}** {} — {}\n",
                        seg.speaker_label,
                        mmss(seg.start_ms),
                        continuation_safe(&seg.text, "> ")
                    ));
                }
                md.push('\n');
            }
        }

        // --- Key moments ---
        if !mem.moments.is_empty() {
            md.push_str("## Key moments\n");
            for moment in &mem.moments {
                let time = hh_mm_label(moment.timestamp);
                // Namespaced by the companion dir, so no prefix needed here.
                let fname = format!("{}-{}.webp", mem.date_key, hhmm(moment.timestamp));

                if copy_thumbnails {
                    if let Some(thumb) = &moment.thumbnail_abs {
                        let dest_rel =
                            PathBuf::from(companion_dir).join("img").join(&fname);
                        md.push_str(&format!(
                            "![[{}/img/{}]]\n",
                            companion_dir, fname
                        ));
                        thumbnails.push(ThumbnailCopy {
                            src: thumb.clone(),
                            dest_rel,
                        });
                    }
                }

                md.push_str(&format!(
                    "{} · {} — [open full →](<file://{}>)\n",
                    time,
                    moment.app_name,
                    moment.full_res_abs.display()
                ));
                md.push('\n');
            }
        }

        // --- By the numbers ---
        let has_stats =
            mem.stats.on_screen_secs > 0 || !mem.stats.app_minutes.is_empty();
        if has_stats {
            md.push_str("## By the numbers\n");
            let screen_label = dur_label(mem.stats.on_screen_secs);
            let mut line = format!("- {} on screen", screen_label);
            if let Some(peak) = mem.stats.peak_hour {
                line.push_str(&format!(" · peak {:02}:00", peak));
            }
            md.push_str(&line);
            md.push('\n');
            for (app, mins) in mem.stats.app_minutes.iter().take(5) {
                md.push_str(&format!("- {} {}\n", app, dur_label(*mins * 60)));
            }
            md.push('\n');
        }

        // --- To-dos ---
        if !mem.stats.todos.is_empty() {
            md.push_str("## To-dos surfaced\n");
            for todo in &mem.stats.todos {
                md.push_str(&format!("- [ ] {}\n", todo));
            }
        }

        RenderedDay { markdown: md, thumbnails }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{gather::*, Emitter};

    fn sample() -> DayMemory {
        DayMemory {
            date_key: "2026-06-10".into(),
            journal_text: Some("shipped the export".into()),
            recap: Some("4h on screen".into()),
            meetings: vec![MeetingMemory {
                title: "Standup".into(),
                started_at: 1_780_000_000,
                duration_secs: 720,
                minutes: Some("release timing".into()),
                transcript: vec![crate::schema::TranscriptSegment {
                    id: 1,
                    meeting_id: 1,
                    start_ms: 0,
                    end_ms: 1000,
                    source: "mic".into(),
                    speaker_label: "You".into(),
                    text: "hi".into(),
                }],
            }],
            moments: vec![MomentMemory {
                timestamp: 1_780_000_100,
                app_name: "VS Code".into(),
                window_title: Some("plan.md".into()),
                thumbnail_abs: Some("/home/jay/.rewindos/thumb/x.webp".into()),
                full_res_abs: "/home/jay/.rewindos/screenshots/x.webp".into(),
            }],
            stats: StatsMemory {
                on_screen_secs: 4 * 3600,
                peak_hour: Some(14),
                app_minutes: vec![("VS Code".into(), 120)],
                todos: vec!["reply to thread".into()],
            },
        }
    }

    #[test]
    fn obsidian_has_frontmatter_callout_embed_and_checkbox() {
        let r = ObsidianEmitter.render(&sample(), "_rewindos", true);
        assert!(r.markdown.starts_with("---\n"), "YAML frontmatter");
        assert!(r.markdown.contains("> [!note]-"), "foldable callout for transcript");
        assert!(r.markdown.contains("![[_rewindos/img/"), "obsidian image embed");
        assert!(r.markdown.contains("- [ ] reply to thread"), "checkbox todo");
        assert!(r.markdown.contains("shipped the export"), "journal leads");
        assert_eq!(r.thumbnails.len(), 1);
        assert!(r.thumbnails[0].dest_rel.starts_with("_rewindos/img"));
    }

    #[test]
    fn obsidian_file_link_uses_angle_brackets() {
        let r = ObsidianEmitter.render(&sample(), "_rewindos", false);
        assert!(
            r.markdown.contains("[open full →](<file://"),
            "angle-bracket file link for space-safe paths"
        );
    }

    #[test]
    fn obsidian_multiline_minutes_stay_in_callout() {
        let mut mem = sample();
        mem.meetings[0].minutes = Some("line1\nline2".into());
        let r = ObsidianEmitter.render(&mem, "_rewindos", false);
        // Every line between the callout open and the next blank line must start with "> "
        let callout_start = r.markdown.find("> [!note]-").expect("callout present");
        let block = &r.markdown[callout_start..];
        // The blank line ends the callout block
        let block_end = block.find("\n\n").unwrap_or(block.len());
        let block_body = &block[..block_end];
        for line in block_body.lines() {
            assert!(
                line.starts_with("> "),
                "callout line does not start with '> ': {:?}",
                line
            );
        }
        // Confirm line2 is present and prefixed correctly
        assert!(r.markdown.contains("> line2"), "continuation line prefixed");
    }
}
