import { cn } from "@/lib/utils";
import { LayoutGrid, List } from "lucide-react";

interface ViewToggleProps {
  view: "grid" | "list";
  onViewChange: (view: "grid" | "list") => void;
}

export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <div className="flex gap-0.5 bg-surface-raised border border-border/30 p-0.5">
      <button
        onClick={() => onViewChange("grid")}
        className={cn(
          "p-1.5 transition-colors",
          view === "grid"
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:text-text-secondary"
        )}
        title="Grid view"
      >
        <LayoutGrid className="size-4" strokeWidth={1.8} />
      </button>
      <button
        onClick={() => onViewChange("list")}
        className={cn(
          "p-1.5 transition-colors",
          view === "list"
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:text-text-secondary"
        )}
        title="List view"
      >
        <List className="size-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}
