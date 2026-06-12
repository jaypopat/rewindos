export interface AppConfig {
  capture: {
    interval_seconds: number;
    change_threshold: number;
    enabled: boolean;
  };
  storage: {
    base_dir: string;
    retention_days: number;
    screenshot_quality: number;
    thumbnail_width: number;
  };
  privacy: {
    excluded_apps: string[];
    excluded_title_patterns: string[];
  };
  ocr: {
    enabled: boolean;
    engine: "tesseract" | "paddleocr";
    tesseract_lang: string;
    max_workers: number;
    model_dir: string;
    python_bin: string;
    idle_timeout_secs: number;
  };
  ui: {
    global_hotkey: string;
    theme: string;
  };
  semantic: {
    enabled: boolean;
    ollama_url: string;
    model: string;
    embedding_dimensions: number;
  };
  chat: {
    enabled: boolean;
    provider: string;
    base_url: string;
    api_key: string;
    model: string;
    max_context_tokens: number;
    max_history_messages: number;
    temperature: number;
  };
  categories: {
    rules: Record<string, string[]>;
  };
  meeting: {
    enabled: boolean;
    engine: string;
    model: string;
    model_dir: string;
    whisper_bin: string;
    keep_audio: boolean;
    summary_enabled: boolean;
    hotkey: string;
    sample_rate: number;
    mic_source: string;
    echo_cancel: boolean;
  };
  vault_export: {
    enabled: boolean;
    format: "obsidian" | "logseq";
    vault_path: string;
    companion_dir: string;
    sections: string[];
    max_moments: number;
    copy_thumbnails: boolean;
    end_of_day_hour: number;
    create_daily_note_if_absent: boolean;
  };
}
