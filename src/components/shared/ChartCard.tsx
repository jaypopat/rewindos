import { cn } from "@/lib/utils";

interface ChartCardProps {
  title: string;
  children: React.ReactNode;
  compact?: boolean;
}

export function ChartCard({ title, children, compact }: ChartCardProps) {
  return (
    <div className={cn(
      "bg-surface-raised rounded-xl border border-border/50",
      compact ? "p-3" : "p-4",
    )}>
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
        {title}
      </h3>
      <div className={compact ? "max-h-[180px] overflow-hidden" : ""}>
        {children}
      </div>
    </div>
  );
}
