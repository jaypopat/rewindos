export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={`w-10 h-[23px] rounded-full transition-colors relative border ${
        checked ? "bg-accent border-accent-deep" : "bg-surface-overlay border-line-2"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[17px] rounded-full transition-all ${
          checked ? "left-[19px] bg-[#1c1208]" : "left-[2px] bg-text-muted"
        }`}
      />
    </button>
  );
}
