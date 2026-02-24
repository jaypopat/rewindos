import { useState } from "react";

export function ListInput({
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
