export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] pb-1 border-b border-border/30">
      {children}
    </h3>
  );
}
