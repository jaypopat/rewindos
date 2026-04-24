import { cn } from "@/lib/utils";

interface FollowupSuggestionsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function FollowupSuggestions({ suggestions, onSelect }: FollowupSuggestionsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {suggestions.map((s, i) => (
        <button
          key={`${i}-${s}`}
          type="button"
          onClick={() => onSelect(s)}
          className={cn(
            "px-3 py-1.5 rounded-full",
            "font-sans text-xs text-text-secondary hover:text-text-primary",
            "border border-border/40 bg-surface-raised/30 hover:border-semantic/40 hover:bg-semantic/5",
            "transition-all",
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
