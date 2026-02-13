use crate::error::{CoreError, Result};
use crate::schema::{
    ActiveBlock, ActivityResponse, AppUsageStat, BoundingBox, DailyActivity, HourlyActivity,
    NewBoundingBox, NewScreenshot, OcrStatus, Screenshot, SearchFilters, SearchResponse,
    SearchResult, TaskUsageStat,
};
use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use std::path::Path;
use std::sync::Once;

mod embedded {
    use refinery::embed_migrations;
    embed_migrations!("migrations");
}

pub struct Database {
    conn: Connection,
}

impl Database {
    /// Register the sqlite-vec extension globally (idempotent).
    fn ensure_sqlite_vec() {
        static INIT: Once = Once::new();
        INIT.call_once(|| unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        });
    }

    /// Open a database at the given path, apply PRAGMAs and run migrations.
    pub fn open(path: &Path) -> Result<Self> {
        Self::ensure_sqlite_vec();
        let conn = Connection::open(path)?;
        let mut db = Self { conn };
        db.apply_pragmas()?;
        db.run_migrations()?;
        Ok(db)
    }

    /// Open an in-memory database (for testing).
    pub fn open_in_memory() -> Result<Self> {
        Self::ensure_sqlite_vec();
        let conn = Connection::open_in_memory()?;
        let mut db = Self { conn };
        db.apply_pragmas()?;
        db.run_migrations()?;
        Ok(db)
    }

    fn apply_pragmas(&self) -> Result<()> {
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -20000;",
        )?;
        Ok(())
    }

    fn run_migrations(&mut self) -> Result<()> {
        embedded::migrations::runner()
            .run(&mut self.conn)
            .map_err(|e| CoreError::Migration(e.to_string()))?;
        Ok(())
    }

    /// Insert a new screenshot record. Returns the new row id.
    pub fn insert_screenshot(&self, new: &NewScreenshot) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO screenshots (timestamp, timestamp_ms, app_name, window_title, window_class,
                                      file_path, thumbnail_path, width, height, file_size_bytes,
                                      perceptual_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                new.timestamp,
                new.timestamp_ms,
                new.app_name,
                new.window_title,
                new.window_class,
                new.file_path,
                new.thumbnail_path,
                new.width,
                new.height,
                new.file_size_bytes,
                new.perceptual_hash,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Insert OCR text for a screenshot into both the content table and FTS5 index.
    pub fn insert_ocr_text(
        &self,
        screenshot_id: i64,
        text: &str,
        word_count: i32,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ocr_text_content (screenshot_id, text_content, word_count)
             VALUES (?1, ?2, ?3)",
            params![screenshot_id, text, word_count],
        )?;
        // Insert into standalone FTS5 table (no triggers, manual sync)
        self.conn.execute(
            "INSERT INTO ocr_fts (text_content, screenshot_id)
             VALUES (?1, ?2)",
            params![text, screenshot_id],
        )?;
        Ok(())
    }

    /// Insert bounding boxes for a screenshot.
    pub fn insert_bounding_boxes(
        &self,
        screenshot_id: i64,
        boxes: &[NewBoundingBox],
    ) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "INSERT INTO ocr_bounding_boxes (screenshot_id, text_content, x, y, width, height, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;

        for b in boxes {
            stmt.execute(params![
                screenshot_id,
                b.text_content,
                b.x,
                b.y,
                b.width,
                b.height,
                b.confidence,
            ])?;
        }
        Ok(())
    }

    /// Update the OCR status of a screenshot.
    pub fn update_ocr_status(&self, screenshot_id: i64, status: OcrStatus) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots SET ocr_status = ?1 WHERE id = ?2",
            params![status.as_str(), screenshot_id],
        )?;
        Ok(())
    }

    /// Get a screenshot by id.
    pub fn get_screenshot(&self, id: i64) -> Result<Option<Screenshot>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, timestamp_ms, app_name, window_title, window_class,
                    file_path, thumbnail_path, width, height, file_size_bytes,
                    perceptual_hash, ocr_status, created_at
             FROM screenshots WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Screenshot {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                timestamp_ms: row.get(2)?,
                app_name: row.get(3)?,
                window_title: row.get(4)?,
                window_class: row.get(5)?,
                file_path: row.get(6)?,
                thumbnail_path: row.get(7)?,
                width: row.get(8)?,
                height: row.get(9)?,
                file_size_bytes: row.get(10)?,
                perceptual_hash: row.get(11)?,
                ocr_status: OcrStatus::parse(
                    &row.get::<_, String>(12)?,
                ),
                created_at: row.get(13)?,
            })
        })?;

        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Browse screenshots in a time range (newest first), without requiring a search query.
    pub fn browse_screenshots(
        &self,
        start_time: Option<i64>,
        end_time: Option<i64>,
        app_name: Option<&str>,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<Screenshot>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, timestamp, timestamp_ms, app_name, window_title, window_class,
                    file_path, thumbnail_path, width, height, file_size_bytes,
                    perceptual_hash, ocr_status, created_at
             FROM screenshots
             WHERE (?1 IS NULL OR timestamp >= ?1)
               AND (?2 IS NULL OR timestamp <= ?2)
               AND (?3 IS NULL OR app_name = ?3)
             ORDER BY timestamp DESC
             LIMIT ?4 OFFSET ?5",
        )?;

        let rows = stmt.query_map(
            params![start_time, end_time, app_name, limit, offset],
            |row| {
                Ok(Screenshot {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    timestamp_ms: row.get(2)?,
                    app_name: row.get(3)?,
                    window_title: row.get(4)?,
                    window_class: row.get(5)?,
                    file_path: row.get(6)?,
                    thumbnail_path: row.get(7)?,
                    width: row.get(8)?,
                    height: row.get(9)?,
                    file_size_bytes: row.get(10)?,
                    perceptual_hash: row.get(11)?,
                    ocr_status: OcrStatus::parse(&row.get::<_, String>(12)?),
                    created_at: row.get(13)?,
                })
            },
        )?;

        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Get recent perceptual hashes for deduplication.
    /// Returns (id, hash) pairs for screenshots since `since_timestamp` (unix seconds).
    pub fn get_recent_hashes(
        &self,
        since_timestamp: i64,
        limit: usize,
    ) -> Result<Vec<(i64, Vec<u8>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, perceptual_hash FROM screenshots
             WHERE timestamp > ?1
             ORDER BY timestamp DESC
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![since_timestamp, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Delete screenshots before a given unix timestamp. Returns number of deleted rows.
    pub fn delete_screenshots_before(&self, timestamp: i64) -> Result<u64> {
        // Delete FTS5 entries first (standalone table, no cascade)
        self.conn.execute(
            "DELETE FROM ocr_fts WHERE screenshot_id IN
             (SELECT id FROM screenshots WHERE timestamp < ?1)",
            params![timestamp],
        )?;
        let count = self.conn.execute(
            "DELETE FROM screenshots WHERE timestamp < ?1",
            params![timestamp],
        )?;
        Ok(count as u64)
    }

    /// Get all distinct app names from screenshots.
    pub fn get_app_names(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT DISTINCT app_name FROM screenshots
             WHERE app_name IS NOT NULL
             ORDER BY app_name",
        )?;

        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut names = Vec::new();
        for row in rows {
            names.push(row?);
        }
        Ok(names)
    }

    /// Full-text search with filters, pagination, and snippet highlighting.
    pub fn search(&self, filters: &SearchFilters) -> Result<SearchResponse> {
        // Count total matches first
        let total_count = self.search_count(filters)?;

        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.timestamp, s.app_name, s.window_title,
                    s.thumbnail_path, s.file_path,
                    snippet(ocr_fts, 0, '<mark>', '</mark>', '...', 32) AS matched_text,
                    rank
             FROM ocr_fts
             JOIN screenshots s ON s.id = ocr_fts.screenshot_id
             WHERE ocr_fts MATCH ?1
               AND (?2 IS NULL OR s.timestamp >= ?2)
               AND (?3 IS NULL OR s.timestamp <= ?3)
               AND (?4 IS NULL OR s.app_name = ?4)
             ORDER BY rank
             LIMIT ?5 OFFSET ?6",
        )?;

        let rows = stmt.query_map(
            params![
                filters.query,
                filters.start_time,
                filters.end_time,
                filters.app_name,
                filters.limit,
                filters.offset,
            ],
            |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    app_name: row.get(2)?,
                    window_title: row.get(3)?,
                    thumbnail_path: row.get(4)?,
                    file_path: row.get(5)?,
                    matched_text: row.get(6)?,
                    rank: row.get(7)?,
                })
            },
        )?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        Ok(SearchResponse {
            results,
            total_count,
            search_mode: None,
        })
    }

    /// Get the OCR text content for a screenshot.
    pub fn get_ocr_text(&self, screenshot_id: i64) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT text_content FROM ocr_text_content WHERE screenshot_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![screenshot_id], |row| {
            row.get::<_, String>(0)
        })?;

        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Get all bounding boxes for a screenshot.
    pub fn get_bounding_boxes(&self, screenshot_id: i64) -> Result<Vec<BoundingBox>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, screenshot_id, text_content, x, y, width, height, confidence
             FROM ocr_bounding_boxes WHERE screenshot_id = ?1
             ORDER BY y, x",
        )?;

        let rows = stmt.query_map(params![screenshot_id], |row| {
            Ok(BoundingBox {
                id: row.get(0)?,
                screenshot_id: row.get(1)?,
                text_content: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
                confidence: row.get(7)?,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// Get OCR text grouped by app session for a time range.
    /// Returns (app_name, window_title, timestamp, ocr_text) tuples ordered by timestamp.
    /// Used for building AI summary prompts.
    pub fn get_ocr_sessions(
        &self,
        start_time: i64,
        end_time: i64,
        limit: i64,
    ) -> Result<Vec<(Option<String>, Option<String>, i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.app_name, s.window_title, s.timestamp, o.text_content
             FROM screenshots s
             INNER JOIN ocr_text_content o ON o.screenshot_id = s.id
             WHERE s.timestamp >= ?1 AND s.timestamp < ?2
               AND o.text_content IS NOT NULL AND length(o.text_content) > 10
             ORDER BY s.timestamp ASC
             LIMIT ?3",
        )?;

        let rows = stmt.query_map(params![start_time, end_time, limit], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Get OCR sessions with screenshot IDs and file paths for richer context.
    /// Returns (id, app_name, window_title, timestamp, file_path, ocr_text) tuples.
    pub fn get_ocr_sessions_with_ids(
        &self,
        start_time: i64,
        end_time: i64,
        limit: i64,
    ) -> Result<Vec<(i64, Option<String>, Option<String>, i64, String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.app_name, s.window_title, s.timestamp, s.file_path, o.text_content
             FROM screenshots s
             INNER JOIN ocr_text_content o ON o.screenshot_id = s.id
             WHERE s.timestamp >= ?1 AND s.timestamp < ?2
               AND o.text_content IS NOT NULL AND length(o.text_content) > 10
             ORDER BY s.timestamp ASC
             LIMIT ?3",
        )?;

        let rows = stmt.query_map(params![start_time, end_time, limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Get app usage statistics since a given unix timestamp.
    pub fn get_app_usage_stats(&self, since: i64) -> Result<Vec<AppUsageStat>> {
        let total: f64 = self.conn.query_row(
            "SELECT COUNT(*) FROM screenshots WHERE timestamp >= ?1 AND app_name IS NOT NULL",
            params![since],
            |row| row.get(0),
        )?;

        if total == 0.0 {
            return Ok(Vec::new());
        }

        let mut stmt = self.conn.prepare(
            "SELECT app_name, COUNT(*) as cnt
             FROM screenshots
             WHERE timestamp >= ?1 AND app_name IS NOT NULL
             GROUP BY app_name
             ORDER BY cnt DESC",
        )?;

        let rows = stmt.query_map(params![since], |row| {
            let count: i64 = row.get(1)?;
            Ok(AppUsageStat {
                app_name: row.get(0)?,
                screenshot_count: count,
                percentage: (count as f64 / total) * 100.0,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Get daily activity (screenshot count + unique apps) since a given unix timestamp.
    pub fn get_daily_activity(&self, since: i64) -> Result<Vec<DailyActivity>> {
        let mut stmt = self.conn.prepare(
            "SELECT date(timestamp, 'unixepoch', 'localtime') as day,
                    COUNT(*) as cnt,
                    COUNT(DISTINCT app_name) as apps
             FROM screenshots
             WHERE timestamp >= ?1
             GROUP BY day
             ORDER BY day",
        )?;

        let rows = stmt.query_map(params![since], |row| {
            Ok(DailyActivity {
                date: row.get(0)?,
                screenshot_count: row.get(1)?,
                unique_apps: row.get(2)?,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Get hourly activity distribution since a given unix timestamp.
    pub fn get_hourly_activity(&self, since: i64) -> Result<Vec<HourlyActivity>> {
        let mut stmt = self.conn.prepare(
            "SELECT CAST(strftime('%H', timestamp, 'unixepoch', 'localtime') AS INTEGER) as hr,
                    COUNT(*) as cnt
             FROM screenshots
             WHERE timestamp >= ?1
             GROUP BY hr
             ORDER BY hr",
        )?;

        let rows = stmt.query_map(params![since], |row| {
            Ok(HourlyActivity {
                hour: row.get(0)?,
                screenshot_count: row.get(1)?,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Get composite activity data since a given unix timestamp.
    pub fn get_activity(&self, since: i64) -> Result<ActivityResponse> {
        let app_usage = self.get_app_usage_stats(since)?;
        let daily_activity = self.get_daily_activity(since)?;
        let hourly_activity = self.get_hourly_activity(since)?;

        let total_screenshots: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM screenshots WHERE timestamp >= ?1",
            params![since],
            |row| row.get(0),
        )?;

        let total_apps: i64 = self.conn.query_row(
            "SELECT COUNT(DISTINCT app_name) FROM screenshots WHERE timestamp >= ?1 AND app_name IS NOT NULL",
            params![since],
            |row| row.get(0),
        )?;

        Ok(ActivityResponse {
            app_usage,
            daily_activity,
            hourly_activity,
            total_screenshots,
            total_apps,
        })
    }

    /// Insert an embedding for a screenshot into the vector table.
    pub fn insert_embedding(&self, screenshot_id: i64, embedding: &[f32]) -> Result<()> {
        let blob: Vec<u8> = embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        self.conn.execute(
            "INSERT INTO ocr_embeddings (screenshot_id, embedding)
             VALUES (?1, ?2)",
            params![screenshot_id, blob],
        )?;
        self.conn.execute(
            "UPDATE screenshots SET embedding_status = 'done' WHERE id = ?1",
            params![screenshot_id],
        )?;
        Ok(())
    }

    /// Get screenshots that have OCR text but no embedding yet.
    pub fn get_pending_embeddings(&self, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, otc.text_content
             FROM screenshots s
             JOIN ocr_text_content otc ON otc.screenshot_id = s.id
             WHERE s.ocr_status = 'done'
               AND s.embedding_status = 'pending'
             ORDER BY s.id
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// KNN vector search — returns (screenshot_id, distance) pairs.
    pub fn vector_search(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<(i64, f64)>> {
        let blob: Vec<u8> = query_embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        let mut stmt = self.conn.prepare(
            "SELECT screenshot_id, distance
             FROM ocr_embeddings
             WHERE embedding MATCH ?1
             ORDER BY distance
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![blob, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    /// Hybrid search combining FTS5 and vector similarity using
    /// Reciprocal Rank Fusion (RRF, k=60).
    pub fn hybrid_search(
        &self,
        filters: &SearchFilters,
        query_embedding: Option<&[f32]>,
    ) -> Result<SearchResponse> {
        use std::collections::HashMap;

        const RRF_K: f64 = 60.0;
        const FUSION_LIMIT: i64 = 100;

        // Get FTS5 results (up to 100)
        let fts_filters = SearchFilters {
            query: filters.query.clone(),
            start_time: filters.start_time,
            end_time: filters.end_time,
            app_name: filters.app_name.clone(),
            limit: FUSION_LIMIT,
            offset: 0,
        };
        let fts_results = self.search(&fts_filters)?;

        // If no embedding provided, just return FTS results with pagination
        let query_embedding = match query_embedding {
            Some(e) => e,
            None => {
                // Apply original pagination
                let start = filters.offset as usize;
                let end = (start + filters.limit as usize).min(fts_results.results.len());
                let paged = if start < fts_results.results.len() {
                    fts_results.results[start..end].to_vec()
                } else {
                    Vec::new()
                };
                return Ok(SearchResponse {
                    results: paged,
                    total_count: fts_results.total_count,
                    search_mode: Some("keyword".to_string()),
                });
            }
        };

        // Get vector results (up to 100)
        let vec_results = self.vector_search(query_embedding, FUSION_LIMIT as usize)?;

        // RRF fusion
        let mut scores: HashMap<i64, f64> = HashMap::new();

        for (rank, result) in fts_results.results.iter().enumerate() {
            *scores.entry(result.id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
        for (rank, (id, _dist)) in vec_results.iter().enumerate() {
            *scores.entry(*id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }

        // Sort by combined RRF score descending
        let mut ranked: Vec<(i64, f64)> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let total_count = ranked.len() as i64;

        // Apply pagination
        let start = filters.offset as usize;
        let end = (start + filters.limit as usize).min(ranked.len());
        let page_ids: Vec<i64> = if start < ranked.len() {
            ranked[start..end].iter().map(|(id, _)| *id).collect()
        } else {
            Vec::new()
        };

        // Build a map from FTS results for quick lookup
        let fts_map: HashMap<i64, &SearchResult> =
            fts_results.results.iter().map(|r| (r.id, r)).collect();

        // Fetch full data for each result
        let mut results = Vec::new();
        for id in &page_ids {
            if let Some(fts_result) = fts_map.get(id) {
                results.push((*fts_result).clone());
            } else {
                // This result came from vector search only — construct a SearchResult
                if let Some(ss) = self.get_screenshot(*id)? {
                    let matched_text = self
                        .get_ocr_text(*id)?
                        .unwrap_or_default();
                    let snippet = if matched_text.len() > 200 {
                        // Find a valid char boundary at or before byte 200
                        let end = matched_text
                            .char_indices()
                            .map(|(i, _)| i)
                            .take_while(|&i| i <= 200)
                            .last()
                            .unwrap_or(0);
                        format!("{}...", &matched_text[..end])
                    } else {
                        matched_text
                    };
                    results.push(SearchResult {
                        id: ss.id,
                        timestamp: ss.timestamp,
                        app_name: ss.app_name,
                        window_title: ss.window_title,
                        thumbnail_path: ss.thumbnail_path,
                        file_path: ss.file_path,
                        matched_text: snippet,
                        rank: 0.0,
                    });
                }
            }
        }

        Ok(SearchResponse {
            results,
            total_count,
            search_mode: Some("hybrid".to_string()),
        })
    }

    /// Get task-level breakdown: app + window title with estimated time.
    pub fn get_task_breakdown(
        &self,
        start: i64,
        end: i64,
        limit: i64,
    ) -> Result<Vec<TaskUsageStat>> {
        let mut stmt = self.conn.prepare(
            "SELECT app_name, window_title, COUNT(*) as captures,
                    COUNT(*) * 5 as estimated_seconds
             FROM screenshots
             WHERE timestamp >= ?1 AND timestamp < ?2
               AND app_name IS NOT NULL
             GROUP BY app_name, window_title
             ORDER BY captures DESC
             LIMIT ?3",
        )?;

        let rows = stmt.query_map(params![start, end, limit], |row| {
            Ok(TaskUsageStat {
                app_name: row.get(0)?,
                window_title: row.get(1)?,
                screenshot_count: row.get(2)?,
                estimated_seconds: row.get(3)?,
            })
        })?;

        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Detect active time blocks by finding gaps >60s between consecutive screenshots.
    pub fn get_active_blocks(&self, start: i64, end: i64) -> Result<Vec<ActiveBlock>> {
        let mut stmt = self.conn.prepare(
            "SELECT timestamp FROM screenshots
             WHERE timestamp >= ?1 AND timestamp < ?2
             ORDER BY timestamp ASC",
        )?;

        let timestamps: Vec<i64> = stmt
            .query_map(params![start, end], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        if timestamps.is_empty() {
            return Ok(Vec::new());
        }

        let mut blocks = Vec::new();
        let mut block_start = timestamps[0];
        let mut block_end = timestamps[0];

        for &ts in &timestamps[1..] {
            if ts - block_end > 60 {
                // Gap detected — close current block
                blocks.push(ActiveBlock {
                    start_time: block_start,
                    end_time: block_end + 5, // add one capture interval
                    duration_secs: block_end - block_start + 5,
                });
                block_start = ts;
            }
            block_end = ts;
        }

        // Close final block
        blocks.push(ActiveBlock {
            start_time: block_start,
            end_time: block_end + 5,
            duration_secs: block_end - block_start + 5,
        });

        Ok(blocks)
    }

    /// Get a persistent daemon state value by key.
    pub fn get_daemon_state(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM daemon_state WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Set a persistent daemon state value by key (upsert).
    pub fn set_daemon_state(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO daemon_state (key, value, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')",
            params![key, value],
        )?;
        Ok(())
    }

    fn search_count(&self, filters: &SearchFilters) -> Result<i64> {
        let mut stmt = self.conn.prepare(
            "SELECT COUNT(*)
             FROM ocr_fts
             JOIN screenshots s ON s.id = ocr_fts.screenshot_id
             WHERE ocr_fts MATCH ?1
               AND (?2 IS NULL OR s.timestamp >= ?2)
               AND (?3 IS NULL OR s.timestamp <= ?3)
               AND (?4 IS NULL OR s.app_name = ?4)",
        )?;

        let count: i64 = stmt.query_row(
            params![
                filters.query,
                filters.start_time,
                filters.end_time,
                filters.app_name,
            ],
            |row| row.get(0),
        )?;

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::NewBoundingBox;

    fn make_test_db() -> Database {
        Database::open_in_memory().expect("failed to open in-memory db")
    }

    fn make_screenshot(ts: i64) -> NewScreenshot {
        NewScreenshot {
            timestamp: ts,
            timestamp_ms: ts * 1000,
            app_name: Some("firefox".to_string()),
            window_title: Some("Test Page".to_string()),
            window_class: Some("Navigator".to_string()),
            file_path: format!("screenshots/2025-01-01/{ts}.webp"),
            thumbnail_path: Some(format!("screenshots/2025-01-01/thumbs/{ts}.webp")),
            width: 1920,
            height: 1080,
            file_size_bytes: 75000,
            perceptual_hash: vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
        }
    }

    #[test]
    fn test_migration_runs() {
        let _db = make_test_db();
    }

    #[test]
    fn test_insert_and_get_screenshot() {
        let db = make_test_db();
        let new = make_screenshot(1706137200);

        let id = db.insert_screenshot(&new).unwrap();
        assert!(id > 0);

        let got = db.get_screenshot(id).unwrap().expect("screenshot not found");
        assert_eq!(got.id, id);
        assert_eq!(got.timestamp, 1706137200);
        assert_eq!(got.app_name.as_deref(), Some("firefox"));
        assert_eq!(got.window_title.as_deref(), Some("Test Page"));
        assert_eq!(got.width, 1920);
        assert_eq!(got.height, 1080);
        assert_eq!(got.ocr_status, OcrStatus::Pending);
        assert_eq!(got.perceptual_hash, vec![0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    }

    #[test]
    fn test_get_nonexistent_screenshot() {
        let db = make_test_db();
        let got = db.get_screenshot(999).unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn test_ocr_text_and_fts5_search() {
        let db = make_test_db();
        let id = db.insert_screenshot(&make_screenshot(1706137200)).unwrap();

        db.insert_ocr_text(id, "The quick brown fox jumps over the lazy dog", 9)
            .unwrap();
        db.update_ocr_status(id, OcrStatus::Done).unwrap();

        let filters = SearchFilters {
            query: "quick brown fox".to_string(),
            start_time: None,
            end_time: None,
            app_name: None,
            limit: 10,
            offset: 0,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.total_count, 1);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].id, id);
        assert!(response.results[0].matched_text.contains("<mark>"));
    }

    #[test]
    fn test_search_with_date_filter() {
        let db = make_test_db();

        let id1 = db.insert_screenshot(&make_screenshot(1000)).unwrap();
        let id2 = db.insert_screenshot(&make_screenshot(2000)).unwrap();
        let id3 = db.insert_screenshot(&make_screenshot(3000)).unwrap();

        db.insert_ocr_text(id1, "hello world from screenshot one", 5).unwrap();
        db.insert_ocr_text(id2, "hello world from screenshot two", 5).unwrap();
        db.insert_ocr_text(id3, "hello world from screenshot three", 5).unwrap();

        // Search with start_time filter
        let filters = SearchFilters {
            query: "hello world".to_string(),
            start_time: Some(1500),
            end_time: None,
            app_name: None,
            limit: 10,
            offset: 0,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.total_count, 2);

        // Search with start_time and end_time
        let filters = SearchFilters {
            query: "hello world".to_string(),
            start_time: Some(1500),
            end_time: Some(2500),
            app_name: None,
            limit: 10,
            offset: 0,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.total_count, 1);
        assert_eq!(response.results[0].id, id2);
    }

    #[test]
    fn test_search_with_app_filter() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(1000);
        ss1.app_name = Some("firefox".to_string());
        let id1 = db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(2000);
        ss2.app_name = Some("code".to_string());
        let id2 = db.insert_screenshot(&ss2).unwrap();

        db.insert_ocr_text(id1, "search query text in firefox", 5).unwrap();
        db.insert_ocr_text(id2, "search query text in vscode", 5).unwrap();

        let filters = SearchFilters {
            query: "search query".to_string(),
            start_time: None,
            end_time: None,
            app_name: Some("firefox".to_string()),
            limit: 10,
            offset: 0,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.total_count, 1);
        assert_eq!(response.results[0].id, id1);
    }

    #[test]
    fn test_search_pagination() {
        let db = make_test_db();

        for i in 0..5 {
            let id = db.insert_screenshot(&make_screenshot(1000 + i)).unwrap();
            db.insert_ocr_text(id, &format!("common search term item {i}"), 4).unwrap();
        }

        // Page 1
        let filters = SearchFilters {
            query: "common search term".to_string(),
            start_time: None,
            end_time: None,
            app_name: None,
            limit: 2,
            offset: 0,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.total_count, 5);
        assert_eq!(response.results.len(), 2);

        // Page 2
        let filters = SearchFilters {
            query: "common search term".to_string(),
            start_time: None,
            end_time: None,
            app_name: None,
            limit: 2,
            offset: 2,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.results.len(), 2);

        // Page 3 (partial)
        let filters = SearchFilters {
            query: "common search term".to_string(),
            start_time: None,
            end_time: None,
            app_name: None,
            limit: 2,
            offset: 4,
        };

        let response = db.search(&filters).unwrap();
        assert_eq!(response.results.len(), 1);
    }

    #[test]
    fn test_recent_hashes() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(100);
        ss1.perceptual_hash = vec![0xAA; 8];
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(200);
        ss2.perceptual_hash = vec![0xBB; 8];
        db.insert_screenshot(&ss2).unwrap();

        let mut ss3 = make_screenshot(300);
        ss3.perceptual_hash = vec![0xCC; 8];
        db.insert_screenshot(&ss3).unwrap();

        let hashes = db.get_recent_hashes(150, 10).unwrap();
        assert_eq!(hashes.len(), 2);
        // Should be ordered DESC by timestamp
        assert_eq!(hashes[0].1, vec![0xCC; 8]);
        assert_eq!(hashes[1].1, vec![0xBB; 8]);
    }

    #[test]
    fn test_delete_screenshots_before() {
        let db = make_test_db();

        db.insert_screenshot(&make_screenshot(100)).unwrap();
        db.insert_screenshot(&make_screenshot(200)).unwrap();
        db.insert_screenshot(&make_screenshot(300)).unwrap();

        let deleted = db.delete_screenshots_before(250).unwrap();
        assert_eq!(deleted, 2);

        // Only the third one should remain
        let hashes = db.get_recent_hashes(0, 100).unwrap();
        assert_eq!(hashes.len(), 1);
    }

    #[test]
    fn test_update_ocr_status() {
        let db = make_test_db();
        let id = db.insert_screenshot(&make_screenshot(1000)).unwrap();

        let ss = db.get_screenshot(id).unwrap().unwrap();
        assert_eq!(ss.ocr_status, OcrStatus::Pending);

        db.update_ocr_status(id, OcrStatus::Processing).unwrap();
        let ss = db.get_screenshot(id).unwrap().unwrap();
        assert_eq!(ss.ocr_status, OcrStatus::Processing);

        db.update_ocr_status(id, OcrStatus::Done).unwrap();
        let ss = db.get_screenshot(id).unwrap().unwrap();
        assert_eq!(ss.ocr_status, OcrStatus::Done);
    }

    #[test]
    fn test_insert_bounding_boxes() {
        let db = make_test_db();
        let id = db.insert_screenshot(&make_screenshot(1000)).unwrap();

        let boxes = vec![
            NewBoundingBox {
                text_content: "Hello".to_string(),
                x: 10,
                y: 20,
                width: 80,
                height: 20,
                confidence: Some(95.0),
            },
            NewBoundingBox {
                text_content: "World".to_string(),
                x: 100,
                y: 20,
                width: 90,
                height: 20,
                confidence: Some(92.5),
            },
        ];

        db.insert_bounding_boxes(id, &boxes).unwrap();

        // Verify they were inserted
        let count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM ocr_bounding_boxes WHERE screenshot_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_get_app_names() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(100);
        ss1.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(200);
        ss2.app_name = Some("code".to_string());
        db.insert_screenshot(&ss2).unwrap();

        let mut ss3 = make_screenshot(300);
        ss3.app_name = Some("firefox".to_string()); // duplicate
        db.insert_screenshot(&ss3).unwrap();

        let names = db.get_app_names().unwrap();
        assert_eq!(names, vec!["code", "firefox"]);
    }

    #[test]
    fn test_get_app_usage_stats() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(1000);
        ss1.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(2000);
        ss2.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss2).unwrap();

        let mut ss3 = make_screenshot(3000);
        ss3.app_name = Some("code".to_string());
        db.insert_screenshot(&ss3).unwrap();

        let stats = db.get_app_usage_stats(0).unwrap();
        assert_eq!(stats.len(), 2);
        // firefox should be first (most screenshots)
        assert_eq!(stats[0].app_name, "firefox");
        assert_eq!(stats[0].screenshot_count, 2);
        assert!((stats[0].percentage - 66.666).abs() < 1.0);
        assert_eq!(stats[1].app_name, "code");
        assert_eq!(stats[1].screenshot_count, 1);
    }

    #[test]
    fn test_get_app_usage_stats_empty() {
        let db = make_test_db();
        let stats = db.get_app_usage_stats(0).unwrap();
        assert!(stats.is_empty());
    }

    #[test]
    fn test_get_daily_activity() {
        let db = make_test_db();

        // Two screenshots on one day, one on another
        // 1706140800 = 2024-01-25 00:00:00 UTC
        let mut ss1 = make_screenshot(1706140800);
        ss1.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(1706140800 + 3600);
        ss2.app_name = Some("code".to_string());
        db.insert_screenshot(&ss2).unwrap();

        let mut ss3 = make_screenshot(1706140800 + 86400); // next day
        ss3.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss3).unwrap();

        let daily = db.get_daily_activity(0).unwrap();
        assert_eq!(daily.len(), 2);
        assert_eq!(daily[0].screenshot_count + daily[1].screenshot_count, 3);
    }

    #[test]
    fn test_get_hourly_activity() {
        let db = make_test_db();

        // Timestamps at different hours
        // 1706140800 = 2024-01-25 00:00:00 UTC
        db.insert_screenshot(&make_screenshot(1706140800)).unwrap(); // hour depends on localtime
        db.insert_screenshot(&make_screenshot(1706140800 + 3600)).unwrap();
        db.insert_screenshot(&make_screenshot(1706140800 + 3600 + 60)).unwrap();

        let hourly = db.get_hourly_activity(0).unwrap();
        assert!(!hourly.is_empty());
        // Total should be 3
        let total: i64 = hourly.iter().map(|h| h.screenshot_count).sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn test_get_activity_composite() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(1000);
        ss1.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(2000);
        ss2.app_name = Some("code".to_string());
        db.insert_screenshot(&ss2).unwrap();

        let activity = db.get_activity(0).unwrap();
        assert_eq!(activity.total_screenshots, 2);
        assert_eq!(activity.total_apps, 2);
        assert_eq!(activity.app_usage.len(), 2);
        assert!(!activity.hourly_activity.is_empty());
    }

    #[test]
    fn test_get_activity_with_since_filter() {
        let db = make_test_db();

        let mut ss1 = make_screenshot(1000);
        ss1.app_name = Some("firefox".to_string());
        db.insert_screenshot(&ss1).unwrap();

        let mut ss2 = make_screenshot(5000);
        ss2.app_name = Some("code".to_string());
        db.insert_screenshot(&ss2).unwrap();

        let activity = db.get_activity(3000).unwrap();
        assert_eq!(activity.total_screenshots, 1);
        assert_eq!(activity.total_apps, 1);
        assert_eq!(activity.app_usage.len(), 1);
        assert_eq!(activity.app_usage[0].app_name, "code");
    }

    #[test]
    fn test_cascade_delete_ocr() {
        let db = make_test_db();
        let id = db.insert_screenshot(&make_screenshot(100)).unwrap();
        db.insert_ocr_text(id, "some text content", 3).unwrap();
        db.insert_bounding_boxes(
            id,
            &[NewBoundingBox {
                text_content: "some".to_string(),
                x: 0,
                y: 0,
                width: 50,
                height: 20,
                confidence: Some(90.0),
            }],
        )
        .unwrap();

        // Delete the screenshot — should cascade
        db.delete_screenshots_before(200).unwrap();

        let ocr_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM ocr_text_content", [], |row| row.get(0))
            .unwrap();
        assert_eq!(ocr_count, 0);

        let bbox_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM ocr_bounding_boxes", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(bbox_count, 0);
    }
}
