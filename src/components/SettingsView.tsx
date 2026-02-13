import { useCallback, useEffect, useState } from "react";
import { getConfig, updateConfig } from "@/lib/api";
import { ScrollArea } from "@/components/ui/scroll-area";

type Tab = "general" | "capture" | "privacy" | "ai" | "storage" | "ocr" | "focus";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "capture", label: "Capture" },
  { id: "privacy", label: "Privacy" },
  { id: "ai", label: "AI / Models" },
  { id: "focus", label: "Focus" },
  { id: "storage", label: "Storage" },
  { id: "ocr", label: "OCR" },
];

interface ConfigState {
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

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("general");
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => setConfig(c as unknown as ConfigState))
      .catch((e) => setError(String(e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await updateConfig(config as unknown as Record<string, unknown>);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config]);

  const update = useCallback(
    <S extends keyof ConfigState, K extends keyof ConfigState[S]>(
      section: S,
      key: K,
      value: ConfigState[S][K],
    ) => {
      setConfig((prev) => {
        if (!prev) return prev;
        return { ...prev, [section]: { ...prev[section], [key]: value } };
      });
    },
    [],
  );

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="font-mono text-xs text-text-muted">
          {error ? `error: ${error}` : "loading config..."}
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <svg className="size-4 text-text-muted" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
          <span className="font-mono text-xs text-text-muted uppercase tracking-wider">settings</span>
        </div>

        <div className="flex items-center gap-2">
          {error && (
            <span className="font-mono text-[10px] text-signal-error">{error}</span>
          )}
          {saved && (
            <span className="font-mono text-[10px] text-signal-active">saved</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 font-mono text-[11px] text-text-primary bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-all disabled:opacity-50 uppercase tracking-wider"
          >
            {saving ? "saving..." : "save"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Tab sidebar */}
        <div className="w-36 border-r border-border/50 py-2 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full text-left px-4 py-1.5 font-mono text-xs transition-all ${
                tab === t.id
                  ? "text-accent bg-accent/5 border-r-2 border-accent"
                  : "text-text-muted hover:text-text-secondary"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <ScrollArea className="flex-1">
          <div className="px-6 py-4 max-w-xl space-y-5">
            {tab === "general" && (
              <>
                <SectionTitle>General</SectionTitle>
                <Field label="Global Hotkey">
                  <TextInput
                    value={config.ui.global_hotkey}
                    onChange={(v) => update("ui", "global_hotkey", v)}
                  />
                </Field>
              </>
            )}

            {tab === "capture" && (
              <>
                <SectionTitle>Screen Capture</SectionTitle>
                <Field label="Enabled">
                  <Toggle
                    checked={config.capture.enabled}
                    onChange={(v) => update("capture", "enabled", v)}
                  />
                </Field>
                <Field label="Interval (seconds)">
                  <NumberInput
                    value={config.capture.interval_seconds}
                    min={1}
                    max={60}
                    onChange={(v) => update("capture", "interval_seconds", v)}
                  />
                </Field>
                <Field label="Change Threshold">
                  <NumberInput
                    value={config.capture.change_threshold}
                    min={0}
                    max={64}
                    onChange={(v) => update("capture", "change_threshold", v)}
                  />
                </Field>
              </>
            )}

            {tab === "privacy" && (
              <>
                <SectionTitle>Privacy</SectionTitle>
                <Field label="Excluded Apps">
                  <ListInput
                    values={config.privacy.excluded_apps}
                    onChange={(v) => update("privacy", "excluded_apps", v)}
                    placeholder="app name"
                  />
                </Field>
                <Field label="Excluded Title Patterns">
                  <ListInput
                    values={config.privacy.excluded_title_patterns}
                    onChange={(v) => update("privacy", "excluded_title_patterns", v)}
                    placeholder="pattern"
                  />
                </Field>
              </>
            )}

            {tab === "ai" && (
              <>
                <SectionTitle>Chat / Ask</SectionTitle>
                <Field label="Enabled">
                  <Toggle
                    checked={config.chat.enabled}
                    onChange={(v) => update("chat", "enabled", v)}
                  />
                </Field>
                <Field label="Ollama URL">
                  <TextInput
                    value={config.chat.ollama_url}
                    onChange={(v) => update("chat", "ollama_url", v)}
                  />
                </Field>
                <Field label="Model">
                  <TextInput
                    value={config.chat.model}
                    onChange={(v) => update("chat", "model", v)}
                  />
                </Field>
                <Field label="Temperature">
                  <NumberInput
                    value={config.chat.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    onChange={(v) => update("chat", "temperature", v)}
                  />
                </Field>
                <Field label="Max History Messages">
                  <NumberInput
                    value={config.chat.max_history_messages}
                    min={2}
                    max={50}
                    onChange={(v) => update("chat", "max_history_messages", v)}
                  />
                </Field>

                <SectionTitle>Semantic Search (Embeddings)</SectionTitle>
                <Field label="Enabled">
                  <Toggle
                    checked={config.semantic.enabled}
                    onChange={(v) => update("semantic", "enabled", v)}
                  />
                </Field>
                <Field label="Embedding Model">
                  <TextInput
                    value={config.semantic.model}
                    onChange={(v) => update("semantic", "model", v)}
                  />
                </Field>
              </>
            )}

            {tab === "focus" && (
              <>
                <SectionTitle>Pomodoro Timer</SectionTitle>
                <Field label="Work (minutes)">
                  <NumberInput
                    value={config.focus.work_minutes}
                    min={1}
                    max={120}
                    onChange={(v) => update("focus", "work_minutes", v)}
                  />
                </Field>
                <Field label="Short Break (minutes)">
                  <NumberInput
                    value={config.focus.short_break_minutes}
                    min={1}
                    max={30}
                    onChange={(v) => update("focus", "short_break_minutes", v)}
                  />
                </Field>
                <Field label="Long Break (minutes)">
                  <NumberInput
                    value={config.focus.long_break_minutes}
                    min={1}
                    max={60}
                    onChange={(v) => update("focus", "long_break_minutes", v)}
                  />
                </Field>
                <Field label="Sessions Before Long Break">
                  <NumberInput
                    value={config.focus.sessions_before_long_break}
                    min={2}
                    max={10}
                    onChange={(v) => update("focus", "sessions_before_long_break", v)}
                  />
                </Field>
                <Field label="Auto-start Breaks">
                  <Toggle
                    checked={config.focus.auto_start_breaks}
                    onChange={(v) => update("focus", "auto_start_breaks", v)}
                  />
                </Field>
                <Field label="Auto-start Work">
                  <Toggle
                    checked={config.focus.auto_start_work}
                    onChange={(v) => update("focus", "auto_start_work", v)}
                  />
                </Field>

                <SectionTitle>Productivity</SectionTitle>
                <Field label="Daily Goal (minutes)">
                  <NumberInput
                    value={config.focus.daily_goal_minutes}
                    min={30}
                    max={960}
                    onChange={(v) => update("focus", "daily_goal_minutes", v)}
                  />
                </Field>
                <Field label="Distraction Apps">
                  <ListInput
                    values={config.focus.distraction_apps}
                    onChange={(v) => update("focus", "distraction_apps", v)}
                    placeholder="app name"
                  />
                </Field>

                <SectionTitle>Activity Categories</SectionTitle>
                <p className="text-xs text-text-muted -mt-2">
                  Add app keywords to categories. These extend the built-in defaults.
                </p>
                <CategoryRulesEditor
                  rules={config.focus.category_rules ?? {}}
                  onChange={(rules) => update("focus", "category_rules", rules)}
                />
              </>
            )}

            {tab === "storage" && (
              <>
                <SectionTitle>Storage</SectionTitle>
                <Field label="Base Directory">
                  <TextInput
                    value={config.storage.base_dir}
                    onChange={(v) => update("storage", "base_dir", v)}
                  />
                </Field>
                <Field label="Retention (days)">
                  <NumberInput
                    value={config.storage.retention_days}
                    min={7}
                    max={365}
                    onChange={(v) => update("storage", "retention_days", v)}
                  />
                </Field>
                <Field label="Screenshot Quality (0-100)">
                  <NumberInput
                    value={config.storage.screenshot_quality}
                    min={1}
                    max={100}
                    onChange={(v) => update("storage", "screenshot_quality", v)}
                  />
                </Field>
                <Field label="Thumbnail Width (px)">
                  <NumberInput
                    value={config.storage.thumbnail_width}
                    min={100}
                    max={800}
                    onChange={(v) => update("storage", "thumbnail_width", v)}
                  />
                </Field>
              </>
            )}

            {tab === "ocr" && (
              <>
                <SectionTitle>OCR</SectionTitle>
                <Field label="Enabled">
                  <Toggle
                    checked={config.ocr.enabled}
                    onChange={(v) => update("ocr", "enabled", v)}
                  />
                </Field>
                <Field label="Tesseract Language">
                  <TextInput
                    value={config.ocr.tesseract_lang}
                    onChange={(v) => update("ocr", "tesseract_lang", v)}
                  />
                </Field>
                <Field label="Max Workers">
                  <NumberInput
                    value={config.ocr.max_workers}
                    min={1}
                    max={8}
                    onChange={(v) => update("ocr", "max_workers", v)}
                  />
                </Field>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// -- Primitives --

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] pb-1 border-b border-border/30">
      {children}
    </h3>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-text-secondary shrink-0">{label}</label>
      <div className="max-w-56">{children}</div>
    </div>
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 bg-surface-raised border border-border/60 text-sm text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
    />
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="w-24 px-2 py-1 bg-surface-raised border border-border/60 text-sm text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
    />
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-9 h-5 rounded-full transition-all relative ${
        checked ? "bg-accent" : "bg-surface-overlay"
      }`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-text-primary transition-all ${
          checked ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

function ListInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = useState("");

  const add = () => {
    if (input.trim() && !values.includes(input.trim())) {
      onChange([...values, input.trim()]);
      setInput("");
    }
  };

  const remove = (idx: number) => {
    onChange(values.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-1.5 w-full">
      <div className="flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="flex-1 px-2 py-1 bg-surface-raised border border-border/60 text-xs text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
        />
        <button
          onClick={add}
          className="px-2 py-1 font-mono text-[10px] text-accent border border-accent/30 hover:bg-accent/10"
        >
          +
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {values.map((v, i) => (
          <span key={v} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-overlay text-[11px] font-mono text-text-secondary">
            {v}
            <button onClick={() => remove(i)} className="text-text-muted hover:text-signal-error text-xs">
              x
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

const DEFAULT_CATEGORIES = [
  "Development", "Browsing", "Communication", "Media", "Productivity", "System",
];

function CategoryRulesEditor({
  rules,
  onChange,
}: {
  rules: Record<string, string[]>;
  onChange: (rules: Record<string, string[]>) => void;
}) {
  const [newCategory, setNewCategory] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});

  const allCategories = [
    ...DEFAULT_CATEGORIES,
    ...Object.keys(rules).filter((c) => !DEFAULT_CATEGORIES.includes(c)),
  ];

  const addKeyword = (category: string) => {
    const kw = (inputs[category] ?? "").trim().toLowerCase();
    if (!kw) return;
    const existing = rules[category] ?? [];
    if (existing.includes(kw)) return;
    onChange({ ...rules, [category]: [...existing, kw] });
    setInputs((prev) => ({ ...prev, [category]: "" }));
  };

  const removeKeyword = (category: string, idx: number) => {
    const existing = rules[category] ?? [];
    const updated = existing.filter((_, i) => i !== idx);
    if (updated.length === 0) {
      const { [category]: _, ...rest } = rules;
      onChange(rest);
    } else {
      onChange({ ...rules, [category]: updated });
    }
  };

  const addCategory = () => {
    const name = newCategory.trim();
    if (!name || allCategories.includes(name)) return;
    onChange({ ...rules, [name]: [] });
    setNewCategory("");
  };

  return (
    <div className="space-y-3 w-full">
      {allCategories.map((cat) => {
        const keywords = rules[cat] ?? [];
        if (keywords.length === 0 && DEFAULT_CATEGORIES.includes(cat)) {
          // Only show default categories if they have user overrides
          return (
            <div key={cat} className="flex items-center gap-2">
              <span className="text-xs text-text-secondary w-28 shrink-0">{cat}</span>
              <div className="flex-1 flex gap-1">
                <input
                  type="text"
                  value={inputs[cat] ?? ""}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [cat]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && addKeyword(cat)}
                  placeholder="add keyword..."
                  className="flex-1 px-2 py-0.5 bg-surface-raised border border-border/60 text-[11px] text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
                />
                <button
                  onClick={() => addKeyword(cat)}
                  className="px-1.5 py-0.5 font-mono text-[10px] text-accent border border-accent/30 hover:bg-accent/10"
                >
                  +
                </button>
              </div>
            </div>
          );
        }
        return (
          <div key={cat} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-secondary w-28 shrink-0">{cat}</span>
              <div className="flex-1 flex gap-1">
                <input
                  type="text"
                  value={inputs[cat] ?? ""}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [cat]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && addKeyword(cat)}
                  placeholder="add keyword..."
                  className="flex-1 px-2 py-0.5 bg-surface-raised border border-border/60 text-[11px] text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
                />
                <button
                  onClick={() => addKeyword(cat)}
                  className="px-1.5 py-0.5 font-mono text-[10px] text-accent border border-accent/30 hover:bg-accent/10"
                >
                  +
                </button>
              </div>
            </div>
            {keywords.length > 0 && (
              <div className="flex flex-wrap gap-1 ml-[7.5rem]">
                {keywords.map((kw, i) => (
                  <span key={kw} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-overlay text-[10px] font-mono text-text-secondary">
                    {kw}
                    <button onClick={() => removeKeyword(cat, i)} className="text-text-muted hover:text-signal-error text-[10px]">
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="flex gap-1 pt-1">
        <input
          type="text"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCategory()}
          placeholder="New category name..."
          className="flex-1 px-2 py-1 bg-surface-raised border border-border/60 text-xs text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
        />
        <button
          onClick={addCategory}
          className="px-2 py-1 font-mono text-[10px] text-accent border border-accent/30 hover:bg-accent/10"
        >
          + Category
        </button>
      </div>
    </div>
  );
}
