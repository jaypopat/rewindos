import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LayoutGrid, CalendarDays, Rewind, Search, Sparkles, Clock, Settings } from "lucide-react";

export type View = "dashboard" | "history" | "rewind" | "search" | "ask" | "focus" | "settings";

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
}

const NAV_ITEMS: { view: View; label: string; icon: React.ReactNode }[] = [
  {
    view: "dashboard",
    label: "Today",
    icon: <LayoutGrid className="size-5" strokeWidth={1.8} />,
  },
  {
    view: "history",
    label: "History",
    icon: <CalendarDays className="size-5" strokeWidth={1.8} />,
  },
  {
    view: "rewind",
    label: "Rewind",
    icon: <Rewind className="size-5" strokeWidth={1.8} />,
  },
  {
    view: "search",
    label: "Search",
    icon: <Search className="size-5" strokeWidth={1.8} />,
  },
  {
    view: "ask",
    label: "Ask",
    icon: <Sparkles className="size-5" strokeWidth={1.8} />,
  },
  {
    view: "focus",
    label: "Focus",
    icon: <Clock className="size-5" strokeWidth={1.8} />,
  },
];

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  return (
    <TooltipProvider>
      <aside className="w-12 flex flex-col items-center py-4 gap-1 border-r border-border/50 bg-surface-raised/50 shrink-0">
        {/* Logo */}
        <div className="mb-4 flex items-center justify-center w-8 h-8">
          <svg viewBox="0 0 24 24" className="size-5 text-accent" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-2 14.5v-9l6 4.5-6 4.5Z" />
          </svg>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ view, label, icon }) => (
            <Tooltip key={view}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onViewChange(view)}
                  className={cn(
                    "relative flex items-center justify-center w-9 h-9 transition-all",
                    activeView === view
                      ? view === "ask"
                        ? "text-semantic bg-semantic/10"
                        : "text-accent bg-accent/10"
                      : "text-text-muted hover:text-text-secondary hover:bg-surface-overlay/50"
                  )}
                >
                  {activeView === view && (
                    <span className={cn(
                      "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r",
                      view === "ask" ? "bg-semantic" : "bg-accent"
                    )} />
                  )}
                  {icon}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Settings — pinned to bottom */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onViewChange("settings")}
              className={cn(
                "relative flex items-center justify-center w-9 h-9 transition-all",
                activeView === "settings"
                  ? "text-accent bg-accent/10"
                  : "text-text-muted hover:text-text-secondary hover:bg-surface-overlay/50"
              )}
            >
              {activeView === "settings" && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent" />
              )}
              <Settings className="size-5" strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </aside>
    </TooltipProvider>
  );
}
