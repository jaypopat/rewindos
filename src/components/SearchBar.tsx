import { useEffect, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAppNames } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { DATE_PRESETS } from "@/lib/date-presets";
import { AppDot } from "./AppDot";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

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
            <Button
              variant="quiet"
              size="icon-xs"
              type="button"
              onClick={() => onQueryChange("")}
            >
              <X className="size-4" strokeWidth={1.7} />
            </Button>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-2 flex-wrap mt-[22px]">
          {DATE_PRESETS.map((preset, i) => (
            <Button
              variant="ghost"
              type="button"
              key={preset.label}
              onClick={() => onDatePresetChange(i)}
              className={chipClass(datePreset === i)}
            >
              {preset.label}
            </Button>
          ))}

          {appNames && appNames.length > 0 && (
            <>
              <span className="w-px h-5 bg-line-2 mx-1" />
              <Button variant="ghost" type="button" onClick={() => onAppFilterChange(undefined)} className={chipClass(!appFilter)}>
                All apps
              </Button>
              {appNames.slice(0, 8).map((name) => (
                <Button
                  variant="ghost"
                  type="button"
                  key={name}
                  onClick={() => onAppFilterChange(appFilter === name ? undefined : name)}
                  className={chipClass(appFilter === name)}
                >
                  <AppDot appName={name} size={6} />
                  {name}
                </Button>
              ))}
              {appNames.length > 8 && (
                <Select
                  value={appFilter && !appNames.slice(0, 8).includes(appFilter) ? appFilter : "__more__"}
                  onValueChange={(value) => onAppFilterChange(value === "__more__" ? undefined : value)}
                >
                  <SelectTrigger className="h-[30px] px-3 rounded-[7px] text-[12.5px] font-[450] bg-transparent border border-line-2 text-text-secondary cursor-pointer hover:border-line-hi">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__more__">More…</SelectItem>
                    {appNames.slice(8).map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}
        </div>
      </div>
    );
}
