//! Meeting capture pipeline (parallel to the always-on screenshot pipeline).
//! `encode` turns captured PCM windows into on-disk Ogg-Opus audio files;
//! `postprocess` runs best-effort embedding backfill and Ollama summary after a meeting stops;
//! `whisper` transcribes the same PCM windows into text segments;
//! `session` runs the per-meeting encode + transcribe + index loop.
pub mod encode;
pub mod postprocess;
pub mod session;
pub mod whisper;
