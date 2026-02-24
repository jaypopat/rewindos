export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
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
