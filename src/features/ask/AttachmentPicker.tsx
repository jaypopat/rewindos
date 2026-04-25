import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { browseScreenshots, search, type SearchFilters } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";

interface AttachmentPickerProps {
  open: boolean;
  onClose: () => void;
  onAttach: (ids: number[]) => void;
}

const DAY = 86_400;

export function AttachmentPicker({ open, onClose, onAttach }: AttachmentPickerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const filters: SearchFilters = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return {
      start_time: now - 3 * DAY,
      end_time: now,
      limit: 60,
      offset: 0,
    };
  }, []);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  const { data: searchResponse } = useQuery({
    queryKey: queryKeys.search(trimmedQuery, filters),
    queryFn: () => search(trimmedQuery, filters),
    enabled: open && hasQuery,
  });

  const { data: recentItems } = useQuery({
    queryKey: ["attachment-picker-recent", filters.start_time, filters.end_time] as const,
    queryFn: () =>
      browseScreenshots(filters.start_time, filters.end_time, undefined, filters.limit),
    enabled: open && !hasQuery,
  });

  const results = hasQuery ? (searchResponse?.results ?? []) : (recentItems ?? []);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAttach = () => {
    onAttach(Array.from(selected));
    setSelected(new Set());
    setQuery("");
    onClose();
  };

  const handleClose = () => {
    setSelected(new Set());
    setQuery("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : handleClose())}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-xs uppercase tracking-[0.2em] text-text-primary">
            pin screenshots to prompt
          </DialogTitle>
        </DialogHeader>

        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-muted pointer-events-none" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search your screen history (empty = recent)"
            className="w-full pl-9 pr-2 py-2 bg-surface-raised/30 border border-border/40 font-sans text-sm text-text-primary placeholder:text-text-muted/60 outline-none focus:border-semantic/40"
          />
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-3 sm:grid-cols-4 gap-2">
          {results.length === 0 ? (
            <div className="col-span-full px-3 py-6 font-mono text-[11px] text-text-muted/70 italic">
              {query ? "no matches" : "no recent screenshots"}
            </div>
          ) : (
            results.map((r) => {
              const isSelected = selected.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => toggle(r.id)}
                  className={cn(
                    "group relative text-left border transition-all",
                    isSelected
                      ? "border-semantic bg-semantic/5"
                      : "border-border/30 hover:border-border/60",
                  )}
                >
                  <div className="aspect-video w-full bg-surface-overlay overflow-hidden">
                    <img
                      src={convertFileSrc(r.thumbnail_path ?? r.file_path)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="p-1.5">
                    <div className="font-mono text-[10px] text-semantic/70">#{r.id}</div>
                    <div className="font-sans text-xs text-text-primary truncate">
                      {r.app_name ?? "unknown"}
                    </div>
                    <div className="font-mono text-[10px] text-text-muted/60 mt-0.5">
                      {formatTs(r.timestamp)}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="absolute top-1 right-1 bg-semantic text-background p-0.5">
                      <Check className="size-3" strokeWidth={3} />
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className="flex items-center justify-between pt-3 border-t border-border/30">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary border border-border/40"
            >
              cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={handleAttach}
              className={cn(
                "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider border transition-all",
                selected.size === 0
                  ? "text-text-muted/40 border-border/20 cursor-not-allowed"
                  : "text-semantic border-semantic/40 hover:bg-semantic/10",
              )}
            >
              attach {selected.size > 0 ? `(${selected.size})` : ""}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
