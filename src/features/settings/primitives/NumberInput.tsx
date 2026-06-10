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
      className="w-24 px-2.5 py-1.5 rounded-[7px] bg-surface-raised border border-line-2 text-[13px] text-text-primary font-mono outline-none focus:border-line-hi transition-colors"
    />
  );
}
