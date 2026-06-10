use crate::vault::{
    gather::DayMemory,
    continuation_safe, dur_label, hh_mm_label, hhmm, mmss, Emitter, RenderedDay, ThumbnailCopy,
};
use std::path::PathBuf;

pub struct LogseqEmitter;

impl Emitter for LogseqEmitter {
    fn render(&self, mem: &DayMemory, _companion_dir: &str, copy_thumbnails: bool) -> RenderedDay {
        let mut md = String::new();
        let mut thumbnails: Vec<ThumbnailCopy> = Vec::new();

        // --- Page properties block ---
        md.push_str("- source:: rewindos\n");
        md.push_str(&format!("  date:: [[{}]]\n", mem.date_key));
        md.push_str("  tags:: rewindos/daily\n");

        // --- Journal ---
        if let Some(text) = &mem.journal_text {
            md.push_str("- ## Your note\n");
            for line in text.lines() {
                md.push_str(&format!("  - {}\n", line));
            }
        }

        // --- Recap ---
        if let Some(recap) = &mem.recap {
            md.push_str("- ## Today\n");
            // continuation prefix matches the 4-space content indent of a "  - " bullet
            md.push_str(&format!("  - {}\n", continuation_safe(recap, "    ")));
        }

        // --- Meetings ---
        if !mem.meetings.is_empty() {
            md.push_str("- ## Meetings\n");
            for m in &mem.meetings {
                let time = hh_mm_label(m.started_at);
                let dur = dur_label(m.duration_secs);
                md.push_str(&format!("  - **{}** {} · {}\n", m.title, time, dur));
                md.push_str("    collapsed:: true\n");
                if let Some(mins) = &m.minutes {
                    // continuation prefix: 6 spaces to stay inside the "    - " bullet
                    md.push_str(&format!("    - > minutes: {}\n", continuation_safe(mins, "      ")));
                }
                for seg in &m.transcript {
                    // continuation prefix: 6 spaces to stay inside the "    - " bullet
                    md.push_str(&format!(
                        "    - **{}** {} — {}\n",
                        seg.speaker_label,
                        mmss(seg.start_ms),
                        continuation_safe(&seg.text, "      ")
                    ));
                }
            }
        }

        // --- Key moments ---
        if !mem.moments.is_empty() {
            md.push_str("- ## Key moments\n");
            for moment in &mem.moments {
                let time = hh_mm_label(moment.timestamp);
                // Prefixed with "rewindos-" to avoid collisions with user attachments in shared assets/.
                let fname = format!(
                    "rewindos-{}-{}.webp",
                    mem.date_key,
                    hhmm(moment.timestamp)
                );

                md.push_str(&format!("  - {} · {}\n", time, moment.app_name));

                if copy_thumbnails {
                    if let Some(thumb) = &moment.thumbnail_abs {
                        md.push_str(&format!("    ![](../assets/{})\n", fname));
                        let dest_rel = PathBuf::from("assets").join(&fname);
                        thumbnails.push(ThumbnailCopy {
                            src: thumb.clone(),
                            dest_rel,
                        });
                    }
                }

                md.push_str(&format!(
                    "    [open full →](<file://{}>)\n",
                    moment.full_res_abs.display()
                ));
            }
        }

        // --- By the numbers ---
        let has_stats =
            mem.stats.on_screen_secs > 0 || !mem.stats.app_minutes.is_empty();
        if has_stats {
            md.push_str("- ## By the numbers\n");
            let screen_label = dur_label(mem.stats.on_screen_secs);
            let mut line = format!("  - {} on screen", screen_label);
            if let Some(peak) = mem.stats.peak_hour {
                line.push_str(&format!(" · peak {:02}:00", peak));
            }
            md.push_str(&line);
            md.push('\n');
            for (app, mins) in mem.stats.app_minutes.iter().take(5) {
                md.push_str(&format!("  - {} {}\n", app, dur_label(*mins * 60)));
            }
        }

        // --- To-dos ---
        if !mem.stats.todos.is_empty() {
            md.push_str("- ## To-dos surfaced\n");
            for todo in &mem.stats.todos {
                md.push_str(&format!("  - TODO {}\n", todo));
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
    fn logseq_has_props_collapsed_block_assets_ref_and_todo() {
        let r = LogseqEmitter.render(&sample(), "_rewindos", true);
        assert!(r.markdown.contains("source:: rewindos"), "page properties");
        assert!(r.markdown.contains("collapsed:: true"), "collapsed transcript block");
        assert!(r.markdown.contains("![](../assets/rewindos-"), "logseq assets ref");
        assert!(r.markdown.contains("- TODO reply to thread"), "logseq TODO marker");
        assert!(r.markdown.contains("shipped the export"));
        assert_eq!(r.thumbnails.len(), 1);
        assert!(r.thumbnails[0].dest_rel.starts_with("assets"));
    }

    #[test]
    fn logseq_file_link_uses_angle_brackets() {
        let r = LogseqEmitter.render(&sample(), "_rewindos", false);
        assert!(
            r.markdown.contains("[open full →](<file://"),
            "angle-bracket file link for space-safe paths"
        );
    }

    #[test]
    fn logseq_multiline_recap_is_indented() {
        let mut mem = sample();
        mem.recap = Some("r1\nr2".into());
        let r = LogseqEmitter.render(&mem, "_rewindos", false);
        // The continuation line "r2" must not appear at column 0 (unindented)
        for line in r.markdown.lines() {
            assert!(
                line != "r2",
                "recap continuation 'r2' must not appear as an unindented line"
            );
        }
        // And it should be present with its indentation
        assert!(r.markdown.contains("r2"), "r2 must appear in output");
        let r2_line = r.markdown.lines().find(|l| l.contains("r2")).unwrap();
        assert!(
            r2_line.starts_with(' '),
            "line containing 'r2' must start with whitespace, got: {:?}",
            r2_line
        );
    }
}
