import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { getDaemonStatus } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useConfigQuery } from "@/hooks/useConfigQuery";
import {
  LayoutGrid,
  CalendarDays,
  Rewind,
  Search,
  Sparkles,
  Settings,
  Bookmark,
  BookOpen,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type View =
  | "dashboard"
  | "history"
  | "rewind"
  | "search"
  | "saved"
  | "journal"
  | "ask"
  | "meetings"
  | "settings";

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
}

interface NavItem {
  view: View;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
}

const NAV_GROUPS: { section: string; items: NavItem[] }[] = [
  {
    section: "Overview",
    items: [
      { view: "dashboard", label: "Home", shortcut: "g d", icon: <LayoutGrid /> },
      { view: "search", label: "Search", shortcut: "g s", icon: <Search /> },
      { view: "history", label: "History", shortcut: "g h", icon: <CalendarDays /> },
      { view: "rewind", label: "Rewind", shortcut: "g r", icon: <Rewind /> },
    ],
  },
  {
    section: "Think",
    items: [
      { view: "ask", label: "Ask", shortcut: "g a", icon: <Sparkles /> },
      { view: "journal", label: "Journal", shortcut: "g j", icon: <BookOpen /> },
      { view: "saved", label: "Saved", shortcut: "g v", icon: <Bookmark /> },
      { view: "meetings", label: "Meetings", shortcut: "g m", icon: <Mic /> },
    ],
  },
  {
    section: "System",
    items: [{ view: "settings", label: "Settings", shortcut: "g ,", icon: <Settings /> }],
  },
];

const COLLAPSE_KEY = "rewindos-sidebar-collapsed";

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(COLLAPSE_KEY) === "1",
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  };

  const { data: status } = useQuery({
    queryKey: queryKeys.daemonStatus(),
    queryFn: getDaemonStatus,
    refetchInterval: 5000,
    retry: false,
  });
  const { data: config } = useConfigQuery();

  const capturing = status?.is_capturing && (status.capture_state ?? "capturing") === "capturing";
  const interval = config?.capture.interval_seconds;

  return (
    <nav
      className={cn(
        "shrink-0 flex flex-col bg-surface-raised border-r border-line pt-[26px] pb-[18px] transition-[width] duration-300",
        collapsed ? "w-14 px-2" : "w-[244px] px-5",
      )}
    >
      {/* Brand + collapse toggle */}
      <div
        className={cn(
          "flex items-center pb-[26px]",
          collapsed ? "flex-col gap-3" : "gap-2 px-1",
        )}
      >
        <span className="text-base font-semibold tracking-tight leading-none">
          R{!collapsed && <>ewind<b className="text-accent font-semibold">OS</b></>}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "grid place-items-center size-7 rounded-md text-text-muted hover:text-text-primary hover:bg-panel",
            !collapsed && "ml-auto",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" strokeWidth={1.7} />
          ) : (
            <PanelLeftClose className="size-4" strokeWidth={1.7} />
          )}
        </Button>
      </div>

      {/* Nav groups */}
      <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.section} className={collapsed ? "mb-2" : "mb-[22px]"}>
            {collapsed ? (
              gi > 0 && <div className="h-px bg-line mx-2 mb-2" />
            ) : (
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint px-1.5 pb-[11px]">
                {group.section}
              </div>
            )}
            {group.items.map(({ view, label, shortcut, icon }) => {
              const active = activeView === view;
              return (
                <Button
                  variant="ghost"
                  key={view}
                  onClick={() => onViewChange(view)}
                  title={`${label} (${shortcut})`}
                  className={cn(
                    "group relative w-full h-auto flex items-center justify-start rounded-[7px] cursor-pointer text-left",
                    collapsed ? "justify-center py-2" : "gap-[11px] px-2.5 py-2",
                    active
                      ? "text-accent-hi"
                      : "text-text-secondary hover:text-text-primary hover:bg-panel",
                  )}
                >
                  {active && (
                    <span
                      className={cn(
                        "animate-navmark absolute top-1/2 -translate-y-1/2 w-0.5 h-4 bg-accent",
                        collapsed ? "-left-2" : "-left-5",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "[&>svg]:size-[17px] [&>svg]:stroke-[1.7] flex-none transition-transform duration-300",
                      active
                        ? "opacity-100"
                        : "opacity-70 group-hover:opacity-100 group-hover:translate-x-px",
                    )}
                  >
                    {icon}
                  </span>
                  {!collapsed && <span className="text-sm font-[450] tracking-tight">{label}</span>}
                </Button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Capture status footer */}
      <div className="pt-4 border-t border-line">
        <div
          className={cn(
            "flex items-center py-1",
            collapsed ? "justify-center" : "gap-2.5 px-1.5",
          )}
          title={
            collapsed
              ? `${status ? (capturing ? "Capturing" : "Paused") : "Connecting"}${interval ? ` · every ${interval}s` : ""}`
              : undefined
          }
        >
          <span
            className={cn(
              "size-[7px] rounded-full flex-none",
              capturing ? "bg-signal-active animate-led-pulse" : "bg-signal-paused",
            )}
          />
          {!collapsed && (
            <div>
              <div className="text-[12.5px] font-medium text-text-secondary">
                {status ? (capturing ? "Capturing" : "Paused") : "Connecting"}
              </div>
              <div className="font-mono text-[10.5px] tracking-[0.04em] text-text-faint mt-px">
                {interval ? `every ${interval}s · OCR live` : "rewindos-daemon"}
              </div>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
