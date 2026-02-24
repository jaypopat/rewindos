export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-text-secondary shrink-0">{label}</label>
      <div className="max-w-56">{children}</div>
    </div>
  );
}
