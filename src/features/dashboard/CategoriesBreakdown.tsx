import { getCategoryColor } from "@/lib/app-categories";
import { formatMins } from "@/lib/format";

interface CategoriesBreakdownProps {
  entries: [string, number][];
  totalMins: number;
}

export function CategoriesBreakdown({ entries, totalMins }: CategoriesBreakdownProps) {
  return (
    <section className="border border-border/50 px-4 py-3 flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-4 mb-3">
          <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] shrink-0">
            Categories
          </h2>
          <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-raised flex-1">
            {entries.map(([cat, mins]) => (
              <div
                key={cat}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(mins / totalMins) * 100}%`,
                  backgroundColor: getCategoryColor(cat),
                  opacity: 0.85,
                }}
                title={`${cat}: ${formatMins(mins)}`}
              />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-5 flex-wrap">
          {entries.map(([cat, mins]) => {
            const pct = Math.round((mins / totalMins) * 100);
            return (
              <div key={cat} className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: getCategoryColor(cat) }}
                />
                <span className="text-xs text-text-secondary">{cat}</span>
                <span className="text-[10px] text-text-muted font-mono tabular-nums">
                  {formatMins(mins)} ({pct}%)
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
