import { cn } from "@/lib/utils";
import { LayoutGrid, List } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ViewToggleProps {
  view: "grid" | "list";
  onViewChange: (view: "grid" | "list") => void;
}

export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <div className="flex gap-0.5 bg-surface-raised border border-border/30 p-0.5">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onViewChange("grid")}
        className={cn(
          "size-auto p-1.5 rounded-none",
          view === "grid"
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:text-text-secondary"
        )}
        title="Grid view"
      >
        <LayoutGrid className="size-4" strokeWidth={1.8} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onViewChange("list")}
        className={cn(
          "size-auto p-1.5 rounded-none",
          view === "list"
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:text-text-secondary"
        )}
        title="List view"
      >
        <List className="size-4" strokeWidth={1.8} />
      </Button>
    </div>
  );
}
