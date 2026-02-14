import { forwardRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAppNames } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { AppDot } from "./AppDot";

const DATE_PRESETS = [
  { label: "All", value: undefined },
  { label: "Today", value: () => todayTimestamp() },
  { label: "Yesterday", value: () => todayTimestamp() - 86400 },
  { label: "7d", value: () => todayTimestamp() - 86400 * 7 },
  { label: "30d", value: () => todayTimestamp() - 86400 * 30 },
] as const;

function todayTimestamp(): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.floor(now.getTime() / 1000);
}

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  appFilter: string | undefined;
  onAppFilterChange: (app: string | undefined) => void;
  datePreset: number;
  onDatePresetChange: (index: number) => void;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  function SearchBar(
    { query, onQueryChange, appFilter, onAppFilterChange, datePreset, onDatePresetChange },
    ref,
  ) {
    const { data: appNames } = useQuery({
      queryKey: queryKeys.appNames(),
      queryFn: getAppNames,
      staleTime: 60_000,
    });

    useEffect(() => {
      if (ref && "current" in ref && ref.current) {
        ref.current.focus();
      }
    }, [ref]);

    return (
      <div className="px-5 pt-4 pb-3 space-y-3">
        {/* Search input */}
        <div className="relative group">
          <svg
            className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted group-focus-within:text-accent transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          <input
            ref={ref}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="What were you looking at?"
            className="w-full h-11 pl-10 pr-10 bg-surface-raised border border-border/50 text-text-primary placeholder:text-text-muted text-sm focus:outline-none focus:border-accent/40 transition-all"
            onKeyDown={(e) => {
              if (e.key === "Escape") onQueryChange("");
            }}
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Filters row */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Date presets */}
          <div className="flex items-center gap-1">
            {DATE_PRESETS.map((preset, i) => (
              <button
                key={preset.label}
                onClick={() => onDatePresetChange(i)}
                className={cn(
                  "px-2.5 py-1 text-xs font-mono transition-colors",
                  datePreset === i
                    ? "bg-accent/15 text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* App filter */}
          {appNames && appNames.length > 0 && (
            <>
              <div className="w-px h-4 bg-border/50" />
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => onAppFilterChange(undefined)}
                  className={cn(
                    "px-2 py-1 rounded-md text-xs font-medium transition-colors",
                    !appFilter
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
                  )}
                >
                  All apps
                </button>
                {appNames.slice(0, 12).map((name) => (
                  <button
                    key={name}
                    onClick={() => onAppFilterChange(appFilter === name ? undefined : name)}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-1 text-xs font-mono transition-colors",
                      appFilter === name
                        ? "bg-accent/15 text-accent"
                        : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
                    )}
                  >
                    <AppDot appName={name} size={6} />
                    {name}
                  </button>
                ))}
                {appNames.length > 12 && (
                  <select
                    value={appFilter && !appNames.slice(0, 12).includes(appFilter) ? appFilter : ""}
                    onChange={(e) => onAppFilterChange(e.target.value || undefined)}
                    className="px-2 py-1 text-xs font-mono bg-surface-raised border border-border/50 text-text-muted cursor-pointer focus:outline-none focus:border-accent/50 appearance-none pr-5"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23475569' stroke-width='2'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='m19.5 8.25-7.5 7.5-7.5-7.5'/%3E%3C/svg%3E")`,
                      backgroundRepeat: "no-repeat",
                      backgroundPosition: "right 4px center",
                      backgroundSize: "10px",
                    }}
                  >
                    <option value="">More...</option>
                    {appNames.slice(12).map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    );
  },
);

export { DATE_PRESETS, todayTimestamp };
