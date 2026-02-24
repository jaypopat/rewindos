export function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 bg-surface-raised border border-border/60 text-sm text-text-primary font-mono outline-none focus:border-accent/40 transition-colors"
    />
  );
}
