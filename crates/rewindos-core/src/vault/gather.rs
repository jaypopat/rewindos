use crate::db::Database;
use crate::error::Result;
use crate::hasher::PerceptualHasher;
use crate::schema::TranscriptSegment;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Clone)]
pub struct MeetingMemory {
    pub title: String,
    pub started_at: i64,
    pub duration_secs: i64,
    pub minutes: Option<String>,
    pub transcript: Vec<TranscriptSegment>,
}

#[derive(Clone)]
pub struct MomentMemory {
    pub timestamp: i64,
    pub app_name: String,
    pub window_title: Option<String>,
    pub thumbnail_abs: Option<PathBuf>,
    pub full_res_abs: PathBuf,
}

#[derive(Clone)]
pub struct StatsMemory {
    pub on_screen_secs: i64,
    pub peak_hour: Option<i32>,
    pub app_minutes: Vec<(String, i64)>,
    pub todos: Vec<String>,
}

#[derive(Clone)]
pub struct DayMemory {
    pub date_key: String,
    pub journal_text: Option<String>,
    pub recap: Option<String>, // filled by caller after resolve_recap
    pub meetings: Vec<MeetingMemory>,
    pub moments: Vec<MomentMemory>,
    pub stats: StatsMemory,
}

impl DayMemory {
    pub fn is_empty(&self) -> bool {
        // recap is included so write_memory's post-pruning emptiness check
        // doesn't drop a recap-only note; gather-time callers check before any
        // recap is set, so this doesn't change skip-day behavior.
        self.journal_text.is_none()
            && self.recap.is_none()
            && self.meetings.is_empty()
            && self.moments.is_empty()
            && self.stats.on_screen_secs == 0
            && self.stats.todos.is_empty()
    }

    pub fn for_date(
        db: &Database,
        date_key: &str,
        day_start: i64,
        day_end: i64,
        max_moments: u32,
        capture_interval_secs: i64,
    ) -> Result<Self> {
        // journal: extract plain text from the Tiptap JSON, preserving newlines
        // between paragraphs so the exported markdown note reads correctly.
        let journal_text = db
            .get_journal_entry(date_key)?
            .map(|e| tiptap_plain_text(&e.content))
            .filter(|t| !t.trim().is_empty());

        // meetings that started within the day
        let mut meetings = Vec::new();
        // Scans the most recent 500 meetings; backfill of very old days may miss meetings beyond that window. TODO: replace with a date-range query.
        for m in db.list_meetings(500, 0)? {
            if m.started_at >= day_start && m.started_at < day_end {
                let dur = m.ended_at.map(|e| (e - m.started_at).max(0)).unwrap_or(0);
                meetings.push(MeetingMemory {
                    title: m.title.clone().unwrap_or_else(|| "Untitled meeting".into()),
                    started_at: m.started_at,
                    duration_secs: dur,
                    minutes: m.summary.clone(),
                    transcript: db.get_meeting_segments(m.id)?,
                });
            }
        }
        meetings.sort_by_key(|m| m.started_at);

        // stats
        let activity = db.get_activity(day_start, Some(day_end))?;
        let blocks = db.get_active_blocks(day_start, day_end, capture_interval_secs)?;
        let on_screen_secs = blocks.iter().map(|b| b.duration_secs).sum();
        let peak_hour = activity
            .hourly_activity
            .iter()
            .max_by_key(|h| h.screenshot_count)
            .filter(|h| h.screenshot_count > 0)
            .map(|h| h.hour);
        let tasks = db.get_task_breakdown(day_start, day_end, 50, capture_interval_secs)?;
        let mut app_secs: HashMap<String, i64> = Default::default();
        for t in &tasks {
            *app_secs.entry(t.app_name.clone()).or_default() += t.estimated_seconds;
        }
        let mut app_minutes: Vec<(String, i64)> = app_secs
            .into_iter()
            .map(|(a, s)| (a, s / 60))
            .filter(|(_, m)| *m > 0)
            .collect();
        app_minutes.sort_by_key(|a| std::cmp::Reverse(a.1));
        let todos = db
            .get_open_todos(date_key, date_key)?
            .into_iter()
            .map(|t| t.text)
            .collect();

        // moments: Task 4 implements select_key_moments; stub returns empty
        let meeting_starts: Vec<i64> = meetings.iter().map(|m| m.started_at).collect();
        let moments = select_key_moments(db, day_start, day_end, max_moments, &meeting_starts)?;

        Ok(DayMemory {
            date_key: date_key.to_string(),
            journal_text,
            recap: None,
            meetings,
            moments,
            stats: StatsMemory { on_screen_secs, peak_hour, app_minutes, todos },
        })
    }
}

/// Extract readable text from a Tiptap JSON document (recursively concatenate
/// text nodes). Unlike db::extract_plain_text (which space-joins for FTS),
/// this preserves block separation as newlines for markdown output.
pub fn tiptap_plain_text(json: &str) -> String {
    fn is_hard_break(v: &serde_json::Value) -> bool {
        v.get("type").and_then(|t| t.as_str()) == Some("hardBreak")
    }
    fn walk(v: &serde_json::Value, out: &mut String) {
        if is_hard_break(v) {
            out.push('\n');
            return;
        }
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            out.push_str(t);
        }
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            for (i, child) in arr.iter().enumerate() {
                walk(child, out);
                // Insert a newline between block siblings, but skip it when
                // the current child is a hardBreak (it emitted its own newline)
                // or the next sibling is a hardBreak (it will emit one).
                let next_is_hard_break =
                    arr.get(i + 1).map(is_hard_break).unwrap_or(false);
                if i + 1 < arr.len() && !is_hard_break(child) && !next_is_hard_break {
                    out.push('\n');
                }
            }
        }
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
        walk(&v, &mut out);
    }
    out.trim().to_string()
}

/// Hamming distance threshold for treating two frames as a real context switch.
/// Deliberately above the scene-dedup threshold (5) so only genuine app changes
/// are flagged as scene boundaries.
const SCENE_DISTANCE: u32 = 6;

/// Pick up to `max` representative frames for the day, in chronological order.
/// Priority: bookmarked frames > meeting-boundary frames > scene-change frames.
/// Dedup by id and by perceptual-hash hamming proximity (≤ 5).
fn select_key_moments(
    db: &Database,
    day_start: i64,
    day_end: i64,
    max: u32,
    meeting_starts: &[i64],
) -> Result<Vec<MomentMemory>> {
    if max == 0 {
        return Ok(Vec::new());
    }

    // All frames for the day, sorted chronologically.
    // 20k covers a full day at 5s cadence (~17,280 frames); query is DESC so a too-small limit would drop mornings.
    let mut frames = db.browse_screenshots(Some(day_start), Some(day_end), None, 20_000, 0)?;
    frames.sort_by_key(|s| s.timestamp);
    // Ensure all day-boundary semantics agree on [start, end) — the query's upper bound is inclusive,
    // but bookmark/meeting filters use exclusive < day_end.
    frames.retain(|s| s.timestamp < day_end);
    if frames.is_empty() {
        return Ok(Vec::new());
    }

    // Priority signals.
    // Scans the most recent 1000 bookmarks; heavy bookmarkers may miss older days. TODO: date-range query.
    let bookmarked: HashSet<i64> = db
        .list_bookmarks(1000, 0)?
        .into_iter()
        .filter(|(_, s)| s.timestamp >= day_start && s.timestamp < day_end)
        .map(|(_, s)| s.id)
        .collect();

    // Build candidates in priority order:
    // 1. bookmarked frames
    // 2. first frame at or after each meeting start
    // 3. scene-change frames (hamming distance ≥ SCENE_DISTANCE from previous),
    //    spread across the day via time buckets, then chronological fallback
    let mut priority: Vec<&crate::schema::Screenshot> = Vec::new();
    priority.extend(frames.iter().filter(|s| bookmarked.contains(&s.id)));
    for start in meeting_starts {
        if let Some(f) = frames.iter().find(|s| s.timestamp >= *start) {
            priority.push(f);
        }
    }

    // Keyframe-style: each frame is compared to the last accepted scene boundary, not the previous frame — slow cumulative drift within SCENE_DISTANCE never triggers.
    let mut scene_changes: Vec<&crate::schema::Screenshot> = Vec::new();
    let mut prev: Option<&Vec<u8>> = None;
    for f in &frames {
        let changed = match prev {
            None => true,
            Some(p) => PerceptualHasher::hamming_distance(p, &f.perceptual_hash) >= SCENE_DISTANCE,
        };
        if changed {
            scene_changes.push(f);
            prev = Some(&f.perceptual_hash);
        }
    }

    // Dedup by id and by hamming proximity (≤ 5); returns true if picked.
    fn try_pick<'a>(
        c: &'a crate::schema::Screenshot,
        picked: &mut Vec<&'a crate::schema::Screenshot>,
        seen_ids: &mut HashSet<i64>,
    ) -> bool {
        if !seen_ids.insert(c.id) {
            return false;
        }
        let near = picked
            .iter()
            .any(|p| PerceptualHasher::hamming_distance(&p.perceptual_hash, &c.perceptual_hash) <= 5);
        if near {
            return false;
        }
        picked.push(c);
        true
    }

    let mut picked: Vec<&crate::schema::Screenshot> = Vec::new();
    let mut seen_ids: HashSet<i64> = HashSet::new();

    // Stage 1: priority candidates (bookmarks, then meeting boundaries).
    for c in priority {
        if picked.len() as u32 >= max {
            break;
        }
        try_pick(c, &mut picked, &mut seen_ids);
    }

    // Stage 2: spread scene-change picks across the day — divide [day_start,
    // day_end) into `max` equal buckets and take the first acceptable
    // scene-change frame in each, so moments don't all cluster at the start.
    if (picked.len() as u32) < max && day_end > day_start {
        let span = day_end - day_start;
        for i in 0..max as i64 {
            if picked.len() as u32 >= max {
                break;
            }
            let bucket_start = day_start + span * i / max as i64;
            let bucket_end = day_start + span * (i + 1) / max as i64;
            for c in scene_changes
                .iter()
                .copied()
                .filter(|s| s.timestamp >= bucket_start && s.timestamp < bucket_end)
            {
                if try_pick(c, &mut picked, &mut seen_ids) {
                    break; // next bucket
                }
            }
        }
    }

    // Stage 3: fall back to the remaining scene-changes chronologically.
    for c in scene_changes.iter().copied() {
        if picked.len() as u32 >= max {
            break;
        }
        try_pick(c, &mut picked, &mut seen_ids);
    }
    picked.sort_by_key(|s| s.timestamp);

    Ok(picked
        .into_iter()
        .map(|s| MomentMemory {
            timestamp: s.timestamp,
            app_name: s.app_name.clone().unwrap_or_else(|| "unknown".into()),
            window_title: s.window_title.clone(),
            thumbnail_abs: s.thumbnail_path.as_ref().map(PathBuf::from),
            full_res_abs: PathBuf::from(&s.file_path),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn gather_empty_day_has_no_activity() {
        let db = Database::open_in_memory().unwrap();
        let mem = DayMemory::for_date(&db, "2026-06-10", 0, 0, 6, 5).unwrap();
        assert!(mem.is_empty());
    }

    #[test]
    fn tiptap_plain_text_preserves_paragraph_breaks() {
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"first"}]},{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}"#;
        assert_eq!(tiptap_plain_text(doc), "first\nsecond");
    }

    #[test]
    fn tiptap_plain_text_handles_hard_break() {
        let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"line one"},{"type":"hardBreak"},{"type":"text","text":"line two"}]}]}"#;
        assert!(tiptap_plain_text(doc).contains("line one\nline two"));
    }

    #[test]
    fn moments_dedup_near_identical_frames() {
        let db = Database::open_in_memory().unwrap();
        // Two near-identical frames (same hash) + one different — expect ≤2 picked,
        // never the duplicate twice.
        let h1 = vec![0u8; 8];
        let mut h2 = vec![0u8; 8];
        h2[0] = 0xFF; // far hash
        for (ts, hash) in [(100, &h1), (105, &h1), (4000, &h2)] {
            db.insert_screenshot(&crate::schema::NewScreenshot {
                timestamp: ts,
                timestamp_ms: ts * 1000,
                app_name: Some("VS Code".into()),
                window_title: Some("x".into()),
                window_class: None,
                file_path: format!("/f/{ts}.webp"),
                thumbnail_path: Some(format!("/t/{ts}.webp")),
                width: 1920,
                height: 1080,
                file_size_bytes: 1,
                perceptual_hash: hash.clone(),
            })
            .unwrap();
        }
        let moments = select_key_moments(&db, 0, 10_000, 6, &[]).unwrap();
        // the two identical frames collapse to one representative
        assert!(moments.len() <= 2, "got {}", moments.len());
        let ts: Vec<i64> = moments.iter().map(|m| m.timestamp).collect();
        assert!(ts.contains(&4000), "the distinct frame must be picked");
    }

    #[test]
    fn gather_collects_journal_and_meetings() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_journal_entry(&crate::schema::UpsertJournalEntry {
            date: "2026-06-10".into(),
            content: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"shipped the export"}]}]}"#.into(),
        }).unwrap();
        let mem = DayMemory::for_date(&db, "2026-06-10", 0, 10_000_000_000, 6, 5).unwrap();
        assert!(mem.journal_text.as_deref().unwrap_or("").contains("shipped the export"));
    }

    /// Scene-change picks must spread across the day, not cluster at the start.
    /// Three distinct scenes early (ts 100, 200, 300) plus one late (ts 9000)
    /// in a 0..10_000 day with max=2: the old chronological fill would take
    /// ts 100 and ts 200; bucket spreading must take one early frame and the
    /// late ts 9000 frame.
    #[test]
    fn moments_spread_across_day_buckets() {
        let db = Database::open_in_memory().unwrap();
        // Pairwise hamming distances ≥ 8, so all four are distinct scenes
        // (≥ SCENE_DISTANCE) and none collapse in dedup (> 5).
        let hash_a = vec![0u8; 8];
        let mut hash_b = vec![0u8; 8];
        hash_b[0] = 0xFF;
        let mut hash_c = vec![0u8; 8];
        hash_c[1] = 0xFF;
        let hash_d = vec![0xFFu8; 8];
        for (ts, hash) in [(100, &hash_a), (200, &hash_b), (300, &hash_c), (9000, &hash_d)] {
            db.insert_screenshot(&crate::schema::NewScreenshot {
                timestamp: ts,
                timestamp_ms: ts * 1000,
                app_name: Some("App".into()),
                window_title: Some("win".into()),
                window_class: None,
                file_path: format!("/f/{ts}.webp"),
                thumbnail_path: Some(format!("/t/{ts}.webp")),
                width: 1920,
                height: 1080,
                file_size_bytes: 1,
                perceptual_hash: hash.clone(),
            })
            .unwrap();
        }
        let moments = select_key_moments(&db, 0, 10_000, 2, &[]).unwrap();
        let ts: Vec<i64> = moments.iter().map(|m| m.timestamp).collect();
        assert_eq!(ts.len(), 2, "max=2 picks two moments; got {:?}", ts);
        assert!(
            ts.contains(&9000),
            "second-half bucket must yield the late frame, got {:?}",
            ts
        );
        assert!(
            ts.iter().any(|t| *t < 5000),
            "first-half bucket must yield an early frame, got {:?}",
            ts
        );
    }

    /// Bookmarked frame wins dedup even when it arrives later in time.
    /// Two frames share near-identical hashes (hamming distance 1, ≤ 5 dedup
    /// threshold): ts=100 (plain) and ts=200 (bookmarked). The bookmark on
    /// ts=200 means it is inserted first into the candidate list (priority 1),
    /// so when ts=100 is encountered as a scene-change candidate it is dropped
    /// as "near" an already-picked frame. Result: exactly one of the pair
    /// survives and it must be the bookmarked ts=200 frame.
    #[test]
    fn bookmarked_frame_wins_near_hash_dedup() {
        let db = Database::open_in_memory().unwrap();

        // hash_a and hash_b differ by exactly 1 bit → hamming distance 1 (≤ 5)
        let hash_a = vec![0u8; 8];
        let mut hash_b = vec![0u8; 8];
        hash_b[0] = 0x01; // flip 1 bit

        let id_100 = db
            .insert_screenshot(&crate::schema::NewScreenshot {
                timestamp: 100,
                timestamp_ms: 100_000,
                app_name: Some("App".into()),
                window_title: Some("win".into()),
                window_class: None,
                file_path: "/f/100.webp".into(),
                thumbnail_path: Some("/t/100.webp".into()),
                width: 1920,
                height: 1080,
                file_size_bytes: 1,
                perceptual_hash: hash_a,
            })
            .unwrap();

        let id_200 = db
            .insert_screenshot(&crate::schema::NewScreenshot {
                timestamp: 200,
                timestamp_ms: 200_000,
                app_name: Some("App".into()),
                window_title: Some("win".into()),
                window_class: None,
                file_path: "/f/200.webp".into(),
                thumbnail_path: Some("/t/200.webp".into()),
                width: 1920,
                height: 1080,
                file_size_bytes: 1,
                perceptual_hash: hash_b,
            })
            .unwrap();

        // Bookmark only the later frame (ts=200).
        db.toggle_bookmark(id_200, None).unwrap();

        let moments = select_key_moments(&db, 0, 10_000, 6, &[]).unwrap();

        // Exactly one of the near-identical pair should survive.
        let timestamps: Vec<i64> = moments.iter().map(|m| m.timestamp).collect();
        assert_eq!(
            timestamps.iter().filter(|&&t| t == 100 || t == 200).count(),
            1,
            "near-identical pair should collapse to one; got {:?}",
            timestamps
        );
        // The bookmarked frame (ts=200) must be the survivor.
        assert!(
            timestamps.contains(&200),
            "bookmarked ts=200 must win dedup; got {:?}",
            timestamps
        );
        // Sanity: the plain frame (ts=100) must NOT appear.
        assert!(
            !timestamps.contains(&100),
            "plain ts=100 must be deduped away; got {:?}",
            timestamps
        );

        // Suppress unused-variable warnings for the ids (we used them above).
        let _ = id_100;
    }
}
