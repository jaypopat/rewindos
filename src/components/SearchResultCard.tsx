import type { SearchResult } from "@/lib/api";
import { getImageUrl } from "@/lib/api";
import { HighlightedText } from "@/lib/utils";
import { AppDot } from "./AppDot";
import { BookmarkButton } from "./BookmarkButton";
import { formatRelativeTime } from "@/lib/format";
import { Layers } from "lucide-react";

interface SearchResultCardProps {
  result: SearchResult;
  index: number;
  onClick: () => void;
}

export function SearchResultCard({ result, index, onClick }: SearchResultCardProps) {
  return (
    <button
      onClick={onClick}
      className="animate-in fade-in slide-in-from-bottom-2 duration-300 ease-quiet w-full grid grid-cols-[150px_1fr] gap-[22px] px-1 py-5 border-b border-line hover:bg-panel transition-colors cursor-pointer text-left group"
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      {/* Thumbnail */}
      <div className="relative h-[90px] rounded-[6px] overflow-hidden bg-panel border border-black/40">
        {result.thumbnail_path && (
          <img
            src={getImageUrl(result.thumbnail_path)}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
        {result.group_count && result.group_count > 1 && (
          <span className="absolute top-[7px] right-[7px] inline-flex items-center gap-1 px-[5px] py-px rounded font-mono text-[9.5px] text-accent-hi border border-accent-line bg-[rgba(20,15,10,0.6)]">
            <Layers className="size-[11px]" strokeWidth={1.7} />
            {result.group_count}
          </span>
        )}
        <div className="absolute top-1 left-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <BookmarkButton screenshotId={result.id} />
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="font-display text-lg tracking-tight truncate">
            {result.window_title ?? result.app_name ?? "Untitled frame"}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-text-faint whitespace-nowrap flex-none">
            {formatRelativeTime(result.timestamp)}
          </span>
        </div>

        <p className="text-sm text-text-secondary leading-[1.55] line-clamp-2 max-w-[70ch]">
          <HighlightedText html={result.matched_text} />
        </p>

        <div className="flex items-center gap-4 mt-3">
          {result.app_name && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-text-muted">
              <AppDot appName={result.app_name} size={8} />
              {result.app_name}
            </span>
          )}
          {result.group_count && result.group_count > 1 && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-text-muted">
              <Layers className="size-3" strokeWidth={1.7} />
              {result.group_count} scenes
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
