export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 border-b border-line">
      <div className="min-w-0">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        {hint && (
          <p className="text-[12.5px] text-text-muted mt-0.5 max-w-[54ch] leading-relaxed">{hint}</p>
        )}
      </div>
      <div className="max-w-56 shrink-0">{children}</div>
    </div>
  );
}
