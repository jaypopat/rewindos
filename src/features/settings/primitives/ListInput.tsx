import { useState } from "react";
import { Input } from "@/components/ui/input";

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
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={placeholder}
          className="h-7 flex-1 rounded-none px-2 text-xs font-mono"
        />
        <button type="button"
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
            <button type="button" onClick={() => remove(i)} className="text-text-muted hover:text-signal-error text-xs">
              x
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
