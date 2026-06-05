//! Meeting capture pipeline (parallel to the always-on screenshot pipeline).
//! `encode` turns captured PCM windows into on-disk Ogg-Opus audio files;
//! `whisper` transcribes the same PCM windows into text segments.
pub mod encode;
pub mod whisper;
