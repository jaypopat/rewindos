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
    tesseract_lang: string;
    max_workers: number;
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
    ollama_url: string;
    model: string;
    max_context_tokens: number;
    max_history_messages: number;
    temperature: number;
  };
  focus: {
    work_minutes: number;
    short_break_minutes: number;
    long_break_minutes: number;
    sessions_before_long_break: number;
    daily_goal_minutes: number;
    distraction_apps: string[];
    auto_start_breaks: boolean;
    auto_start_work: boolean;
    category_rules: Record<string, string[]>;
  };
}
