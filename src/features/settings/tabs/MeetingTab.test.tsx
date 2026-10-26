import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { AppConfig } from "@/lib/config";

vi.mock("@/lib/api", () => ({
  whisperModelPresent: vi.fn().mockResolvedValue(true),
  downloadWhisperModel: vi.fn(),
}));

import { MeetingTab } from "./MeetingTab";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeConfig(overrides: Partial<AppConfig["meeting"]> = {}): AppConfig {
  return {
    capture: { interval_seconds: 5, change_threshold: 0.1, enabled: true },
    storage: { base_dir: "", retention_days: 30, screenshot_quality: 80, thumbnail_width: 320 },
    privacy: { excluded_apps: [], excluded_title_patterns: [] },
    ocr: {
      enabled: true, engine: "tesseract", tesseract_lang: "eng", max_workers: 2,
      model_dir: "", python_bin: "", idle_timeout_secs: 60,
    },
    ui: { global_hotkey: "", theme: "dark" },
    semantic: { enabled: false, ollama_url: "", model: "", embedding_dimensions: 768 },
    chat: {
      enabled: false, provider: "ollama", base_url: "", api_key: "", model: "",
      max_context_tokens: 4096, max_history_messages: 10, temperature: 0.7, agentic_tools: false,
    },
    categories: { rules: {} },
    meeting: {
      enabled: true,
      engine: "whisper-cpp",
      service_url: "http://127.0.0.1:8000",
      service_api_key: "",
      service_model: "whisper-1",
      service_timeout_secs: 120,
      model: "base.en",
      model_dir: "",
      whisper_bin: "whisper-cli",
      keep_audio: true,
      summary_enabled: true,
      hotkey: "Ctrl+Shift+M",
      sample_rate: 16000,
      mic_source: "",
      echo_cancel: false,
      ...overrides,
    },
    vault_export: {
      enabled: false, format: "obsidian", vault_path: "", companion_dir: "",
      sections: [], max_moments: 20, copy_thumbnails: false, end_of_day_hour: 22,
      create_daily_note_if_absent: false,
    },
  };
}

describe("MeetingTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows whisper model + download controls for built-in engine", async () => {
    const update = vi.fn();
    render(<MeetingTab config={makeConfig()} update={update} />, { wrapper });
    expect(screen.getAllByText(/^Whisper model$/i)).toHaveLength(2);
    expect(await screen.findByText(/ggml-base\.en\.bin present/)).toBeInTheDocument();
    expect(screen.queryByText(/server url/i)).toBeNull();
  });

  it("shows server URL + timeout, no API key or model field for native whisper.cpp server", () => {
    const update = vi.fn();
    render(
      <MeetingTab config={makeConfig({ engine: "whisper-cpp-server" })} update={update} />,
      { wrapper },
    );
    expect(screen.getByText(/server url/i)).toBeInTheDocument();
    expect(screen.getByText(/timeout \(seconds\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/^API Key$/i)).toBeNull();
    expect(screen.queryByText(/whisper model status/i)).toBeNull();
  });

  it("shows server URL, API key, model, timeout for openai-compatible engine", () => {
    const update = vi.fn();
    render(
      <MeetingTab config={makeConfig({ engine: "openai-compatible" })} update={update} />,
      { wrapper },
    );
    expect(screen.getByText(/server url/i)).toBeInTheDocument();
    expect(screen.getByText(/^API Key$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Model$/i)).toBeInTheDocument();
    expect(screen.getByText(/timeout \(seconds\)/i)).toBeInTheDocument();
  });
});
