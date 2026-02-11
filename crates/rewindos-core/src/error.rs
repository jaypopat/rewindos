use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("config error: {0}")]
    Config(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ocr error: {0}")]
    Ocr(String),

    #[error("migration error: {0}")]
    Migration(String),

    #[error("hash error: {0}")]
    Hash(String),

    #[error("embedding error: {0}")]
    Embedding(String),

    #[error("chat error: {0}")]
    Chat(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
