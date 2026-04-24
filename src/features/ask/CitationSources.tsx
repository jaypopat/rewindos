import { useQuery } from "@tanstack/react-query";
import { getScreenshotsByIds } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { convertFileSrc } from "@tauri-apps/api/core";

interface CitationSourcesProps {
  ids: number[];
  onSelect?: (id: number) => void;
}

export function CitationSources({ ids, onSelect }: CitationSourcesProps) {
  const { data: screenshots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds(ids),
    queryFn: () => getScreenshotsByIds(ids),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });

  if (ids.length === 0) return null;

  return (
    <div className="mt-3 border border-border/40 bg-surface-raised/10">
      <div className="px-2.5 py-1 border-b border-border/30 flex items-center justify-between">
        <span className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
          sources
        </span>
        <span className="font-mono text-[10px] text-text-muted/70">{ids.length}</span>
      </div>
      <div className="p-2 flex flex-wrap gap-2">
        {screenshots.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect?.(s.id)}
            className={cn(
              "group flex items-start gap-2 p-1.5 border border-border/30 hover:border-semantic/40 bg-surface-raised/30 hover:bg-semantic/5 transition-all",
              "w-64 text-left",
            )}
          >
            <div className="w-20 h-14 shrink-0 bg-surface-overlay overflow-hidden">
              <img
                src={convertFileSrc(s.thumbnail_path ?? s.file_path)}
                alt=""
                className="w-full h-full object-cover"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-semantic/70 group-hover:text-semantic">
                  #{s.id}
                </span>
                <span className="font-sans text-[11px] text-text-primary truncate">
                  {s.app_name ?? "unknown"}
                </span>
              </div>
              <div className="font-mono text-[10px] text-text-muted/70 mt-0.5">
                {formatTimestamp(s.timestamp)}
              </div>
              {s.window_title && (
                <div className="font-sans text-[10px] text-text-muted truncate mt-0.5">
                  {s.window_title}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
