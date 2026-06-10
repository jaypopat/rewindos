export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="font-mono text-[10.5px] text-text-faint uppercase tracking-[0.18em] pt-8 pb-2 first:pt-0">
      {children}
    </h3>
  );
}
