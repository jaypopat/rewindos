export function NumberInput({
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
