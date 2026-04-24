import { cn } from "@/lib/utils";

interface CitationChipProps {
  id: number;
  onClick?: (id: number) => void;
}

export function CitationChip({ id, onClick }: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onClick?.(id);
      }}
      className={cn(
        "inline-flex items-center px-1 mx-0.5 font-mono text-[11px]",
        "text-semantic/80 hover:text-semantic",
        "border border-semantic/30 hover:border-semantic/60 hover:bg-semantic/10",
        "transition-all align-baseline",
      )}
      aria-label={`screenshot ${id}`}
    >
      #{id}
    </button>
  );
}
