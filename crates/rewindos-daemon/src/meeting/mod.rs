//! Meeting capture pipeline (parallel to the always-on screenshot pipeline).
//! `encode` turns captured PCM windows into on-disk Ogg-Opus audio files.
pub mod encode;
