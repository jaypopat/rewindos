pub mod app_label;
pub mod chat;
pub mod chat_store;
pub mod config;
pub mod db;
pub mod embedding;
pub mod error;
pub mod hasher;
pub mod mcp;
pub mod ocr;
pub mod paddle_ocr;
pub mod schema;
pub mod summary;
pub mod usage;
pub mod vault;
pub mod whisper_model;

/// App version, injected from src-tauri/tauri.conf.json at build time (build.rs).
/// Falls back to the crate version if the config wasn't readable.
pub const VERSION: &str = match option_env!("REWINDOS_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

pub use config::AppConfig;
pub use db::Database;
pub use error::{CoreError, Result};
