import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { search, getAppNames, getImageUrl, type SearchFilters } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { parseFragments } from "@/lib/recall-parse";
import { useDebounce } from "@/hooks/useDebounce";
import { HighlightedText, cn } from "@/lib/utils";
import { formatRelativeTime, formatNumber } from "@/lib/format";

const EXAMPLE_FRAGMENTS = [
  "that postgres error in ghostty",
  "pricing table last week",
  "what was I reading at lunch?",
  "docs from monday",
];

interface RecallPaletteProps {
  open: boolean;
  onClose: () => void;
  /** ↵ — open the frame in the detail view. */
  onOpenResult: (id: number, siblingIds?: number[]) => void;
  /** ⌘↵ — jump into Rewind at the frame's moment. */
  onRewindTo: (timestamp: number) => void;
}

export function RecallPalette({ open, onClose, onOpenResult, onRewindTo }: RecallPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedValue, setSelectedValue] = useState("");
  const debouncedQuery = useDebounce(query, 150);

  // Start each opening with an empty query. Adjusted during render (not in an
  // effect) so there's no stale frame, and so it fires for every open path
  // including the ⌘K toggle, which closes the dialog without an onOpenChange.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setQuery("");
  }

  const { data: appNames = [] } = useQuery({
    queryKey: queryKeys.appNames(),
    queryFn: getAppNames,
    staleTime: 60_000,
    enabled: open,
  });

  const fragments = useMemo(
    () => parseFragments(debouncedQuery, appNames),
    [debouncedQuery, appNames],
  );

  const hasQuery = debouncedQuery.trim().length > 1;
  const searchQuery = fragments.content || debouncedQuery.trim();
  const filters: SearchFilters = useMemo(
    () => ({
      start_time: fragments.timeRange?.start,
      end_time: fragments.timeRange?.end,
      app_name: fragments.app ?? undefined,
      limit: 6,
      offset: 0,
    }),
    [fragments],
  );

  const { data } = useQuery({
    queryKey: ["recall-palette", searchQuery, filters] as const,
    queryFn: () => search(searchQuery, filters),
    enabled: open && hasQuery && searchQuery.length > 0,
    placeholderData: (prev) => prev,
  });
  const results = hasQuery ? (data?.results ?? []) : [];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "top-[16vh] translate-y-0 w-[620px] max-w-[calc(100vw-48px)] gap-0 p-0 overflow-hidden",
          "rounded-[14px] border-line-hi bg-surface-raised",
          // hide the built-in close X — esc and click-outside do the job
          "[&>button]:hidden",
        )}
        style={{ boxShadow: "0 50px 100px -40px #000" }}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Recall</DialogTitle>
        <Command
          shouldFilter={false}
          value={selectedValue}
          onValueChange={setSelectedValue}
          onKeyDown={(e) => {
            // ⌘↵ / Ctrl-↵ — rewind to the selected frame's moment
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              const r = results.find((x) => String(x.id) === selectedValue);
              if (r) {
                onClose();
                onRewindTo(r.timestamp);
              }
            }
          }}
          className={cn(
            "bg-transparent",
            "[&_[cmdk-input-wrapper]]:px-[18px] [&_[cmdk-input-wrapper]]:py-1.5 [&_[cmdk-input-wrapper]]:border-line",
            "[&_[cmdk-input-wrapper]_svg]:text-accent [&_[cmdk-input-wrapper]_svg]:opacity-100 [&_[cmdk-input-wrapper]_svg]:size-[18px] [&_[cmdk-input-wrapper]_svg]:mr-3",
          )}
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Describe what you remember…"
            className="h-12 text-[16.5px] text-text-primary placeholder:text-text-muted"
          />

          {/* Understood: the hybrid search, made legible */}
          {hasQuery && (
            <div className="flex flex-wrap items-center gap-2 px-[18px] py-3 border-b border-line">
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-faint">
                understood:
              </span>
              {fragments.app && (
                <span className="inline-flex items-center h-[26px] px-3 rounded-[7px] text-[11.5px] font-[450] bg-accent-muted border border-accent-line text-accent-hi">
                  app · {fragments.app}
                </span>
              )}
              {fragments.timeLabel && (
                <span className="inline-flex items-center h-[26px] px-3 rounded-[7px] text-[11.5px] font-[450] bg-accent-muted border border-accent-line text-accent-hi">
                  when · {fragments.timeLabel}
                </span>
              )}
              {fragments.content && (
                <span className="inline-flex items-center h-[26px] px-3 rounded-[7px] text-[11.5px] font-[450] border border-dashed border-line-2 text-text-secondary">
                  looks like · “{fragments.content}”
                </span>
              )}
            </div>
          )}

          <CommandList className="max-h-[420px]">
            {hasQuery && (
              <CommandEmpty className="px-[18px] py-5 text-left text-[13px] text-text-muted">
                Nothing matched that memory yet — try fewer words, or a different fragment.
              </CommandEmpty>
            )}

            {results.map((r) => (
              <CommandItem
                key={r.id}
                value={String(r.id)}
                onSelect={() => {
                  onClose();
                  onOpenResult(r.id, results.map((x) => x.id));
                }}
                className="group grid grid-cols-[104px_1fr] gap-4 px-[18px] py-3 rounded-none border-b border-line last:border-b-0 cursor-pointer items-start"
              >
                <div className="h-[60px] rounded-[6px] overflow-hidden bg-panel border border-black/40">
                  {r.thumbnail_path && (
                    <img
                      src={getImageUrl(r.thumbnail_path)}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-[13.5px] font-medium truncate">
                      {r.window_title ?? r.app_name ?? "Untitled frame"}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-text-faint whitespace-nowrap flex-none">
                      {formatRelativeTime(r.timestamp)}
                    </span>
                  </div>
                  <div className="text-xs text-text-muted mt-0.5 truncate">
                    <HighlightedText html={r.matched_text} />
                  </div>
                  <div className="flex items-center gap-2.5 mt-1">
                    {r.app_name && (
                      <span className="font-mono text-[9.5px] text-text-faint">{r.app_name}</span>
                    )}
                    {r.group_count && r.group_count > 1 && (
                      <span className="font-mono text-[9.5px] text-text-muted">
                        {r.group_count} scenes
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[9.5px] text-text-faint opacity-0 group-data-[selected=true]:opacity-100">
                      ↵ open · ⌘↵ rewind here
                    </span>
                  </div>
                </div>
              </CommandItem>
            ))}

            {/* Empty state — example fragments to feel out the syntax */}
            {!hasQuery && (
              <div className="flex flex-wrap gap-2 px-[18px] pt-3 pb-4">
                {EXAMPLE_FRAGMENTS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setQuery(s)}
                    className="inline-flex items-center h-7 px-3 rounded-[7px] text-xs font-[450] text-text-secondary border border-line-2 hover:border-line-hi hover:text-text-primary transition-colors cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </CommandList>

          {/* Footer */}
          <div className="flex gap-4 px-[18px] py-[9px] border-t border-line bg-panel">
            <span className="font-mono text-[9.5px] text-text-faint">↑↓ navigate</span>
            <span className="font-mono text-[9.5px] text-text-faint">↵ open</span>
            <span className="font-mono text-[9.5px] text-text-faint">⌘↵ rewind here</span>
            <span className="font-mono text-[9.5px] text-text-faint">esc</span>
            <span className="ml-auto font-mono text-[9.5px] text-text-faint">
              {data?.total_count != null && hasQuery
                ? `${formatNumber(data.total_count)} frames matched · locally`
                : "searching your screen history · locally"}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
