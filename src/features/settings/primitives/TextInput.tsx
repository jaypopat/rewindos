export function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2.5 py-1.5 rounded-[7px] bg-surface-raised border border-line-2 text-[13px] text-text-primary font-mono outline-none focus:border-line-hi transition-colors"
    />
  );
}
