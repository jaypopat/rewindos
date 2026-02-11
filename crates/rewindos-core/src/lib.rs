pub mod chat;
pub mod config;
pub mod db;
pub mod embedding;
pub mod error;
pub mod hasher;
pub mod ocr;
pub mod schema;

pub use config::AppConfig;
pub use db::Database;
pub use error::{CoreError, Result};
