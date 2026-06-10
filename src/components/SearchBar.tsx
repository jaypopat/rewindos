import { useEffect, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAppNames } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { DATE_PRESETS } from "@/lib/date-presets";
import { AppDot } from "./AppDot";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  appFilter: string | undefined;
  onAppFilterChange: (app: string | undefined) => void;
  datePreset: number;
  onDatePresetChange: (index: number) => void;
  ref?: Ref<HTMLInputElement>;
}

const chipClass = (on: boolean) =>
  cn(
    "inline-flex items-center gap-1.5 h-[30px] px-3 rounded-[7px] text-[12.5px] font-[450] border transition-colors whitespace-nowrap",
    on
      ? "bg-accent-muted border-accent-line text-accent-hi"
      : "border-line-2 text-text-secondary hover:border-line-hi hover:text-text-primary",
  );

export function SearchBar(
  { query, onQueryChange, appFilter, onAppFilterChange, datePreset, onDatePresetChange, ref }: SearchBarProps,
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
      <div className="px-14 pt-11 pb-1 max-w-[1180px] w-full mx-auto">
        {/* The search line — editorial, a single rule */}
        <div className="flex items-center gap-3.5 pb-[18px] border-b border-line-2">
          <Search className="size-[22px] text-accent flex-none" strokeWidth={1.7} />
          <Input
            ref={ref}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search everything you've seen…"
            className="h-auto flex-1 rounded-none border-none bg-transparent p-0 font-display text-[28px] tracking-tight"
            onKeyDown={(e) => {
              if (e.key === "Escape") onQueryChange("");
            }}
          />
          {query && (
            <button type="button"
              onClick={() => onQueryChange("")}
              className="text-text-muted hover:text-text-secondary transition-colors"
            >
              <X className="size-4" strokeWidth={1.7} />
            </button>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 flex-wrap mt-[22px]">
          {DATE_PRESETS.map((preset, i) => (
            <button type="button"
              key={preset.label}
              onClick={() => onDatePresetChange(i)}
              className={chipClass(datePreset === i)}
            >
              {preset.label}
            </button>
          ))}

          {appNames && appNames.length > 0 && (
            <>
              <span className="w-px h-5 bg-line-2 mx-1" />
              <button type="button" onClick={() => onAppFilterChange(undefined)} className={chipClass(!appFilter)}>
                All apps
              </button>
              {appNames.slice(0, 8).map((name) => (
                <button type="button"
                  key={name}
                  onClick={() => onAppFilterChange(appFilter === name ? undefined : name)}
                  className={chipClass(appFilter === name)}
                >
                  <AppDot appName={name} size={6} />
                  {name}
                </button>
              ))}
              {appNames.length > 8 && (
                <select
                  value={appFilter && !appNames.slice(0, 8).includes(appFilter) ? appFilter : ""}
                  onChange={(e) => onAppFilterChange(e.target.value || undefined)}
                  className="h-[30px] px-3 pr-6 rounded-[7px] text-[12.5px] font-[450] bg-transparent border border-line-2 text-text-secondary cursor-pointer focus:outline-none hover:border-line-hi appearance-none"
                  style={{
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236a6457' stroke-width='2'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' d='m19.5 8.25-7.5 7.5-7.5-7.5'/%3E%3C/svg%3E")`,
                    backgroundRepeat: "no-repeat",
                    backgroundPosition: "right 6px center",
                    backgroundSize: "10px",
                  }}
                >
                  <option value="">More…</option>
                  {appNames.slice(8).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
      </div>
    );
}
