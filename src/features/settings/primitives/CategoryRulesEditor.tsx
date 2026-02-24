import { useState } from "react";

const DEFAULT_CATEGORIES = [
  "Development", "Browsing", "Communication", "Media", "Productivity", "System",
];

export function CategoryRulesEditor({
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
