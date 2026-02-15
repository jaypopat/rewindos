import { Sparkles, Search } from "lucide-react";

interface SemanticBadgeProps {
  mode: string | undefined;
}

export function SemanticBadge({ mode }: SemanticBadgeProps) {
  if (mode === "hybrid") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-semantic/30 bg-semantic/5 text-semantic text-[10px] font-mono uppercase tracking-wider">
        <Sparkles className="size-3" strokeWidth={2} />
        ai search
      </span>
    );
  }

  if (mode === "keyword") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-border/30 bg-surface-raised/50 text-text-muted text-[10px] font-mono uppercase tracking-wider">
        <Search className="size-3" strokeWidth={2} />
        keyword
      </span>
    );
  }

  return null;
}
