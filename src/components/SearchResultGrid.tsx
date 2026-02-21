import type { SearchResult } from "@/lib/api";
import { getImageUrl } from "@/lib/api";
import { HighlightedText } from "@/lib/utils";
import { AppDot } from "./AppDot";
import { BookmarkButton } from "./BookmarkButton";
import { formatRelativeTime } from "@/lib/format";
import { ImageIcon } from "lucide-react";

interface SearchResultGridProps {
  results: SearchResult[];
  onSelectResult: (id: number) => void;
}

export function SearchResultGrid({ results, onSelectResult }: SearchResultGridProps) {
  return (
    <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
      {results.map((result, i) => (
        <button
          key={result.id}
          onClick={() => onSelectResult(result.id)}
          className="animate-fade-in-up group relative overflow-hidden bg-surface-raised border border-border/30 hover:border-accent/30 transition-all cursor-pointer text-left"
          style={{ animationDelay: `${i * 30}ms` }}
        >
          {/* Thumbnail */}
          <div className="aspect-video bg-surface-overlay relative">
            {result.thumbnail_path ? (
              <img
                src={getImageUrl(result.thumbnail_path)}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-text-muted">
                <ImageIcon className="size-8 opacity-30" strokeWidth={1} />
              </div>
            )}
            {result.group_count && result.group_count > 1 && (
              <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-surface/80 backdrop-blur-sm border border-border/40 text-[10px] font-mono text-text-secondary">
                +{result.group_count - 1} similar
              </span>
            )}
            <div className="absolute top-1.5 left-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <BookmarkButton screenshotId={result.id} />
            </div>
          </div>

          {/* Metadata overlay */}
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface/95 via-surface/70 to-transparent p-3 pt-8">
            <div className="flex items-center gap-1.5 mb-1">
              {result.app_name && (
                <>
                  <AppDot appName={result.app_name} size={6} />
                  <span className="text-[10px] font-mono text-text-secondary truncate">
                    {result.app_name}
                  </span>
                </>
              )}
              <span className="text-[10px] text-text-muted ml-auto shrink-0">
                {formatRelativeTime(result.timestamp)}
              </span>
            </div>
            {result.window_title && (
              <p className="text-xs text-text-primary truncate leading-tight">
                {result.window_title}
              </p>
            )}
          </div>

          {/* Hover: show matched text */}
          <div className="absolute inset-0 bg-surface/90 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity p-3 flex flex-col justify-end">
            <div className="flex items-center gap-1.5 mb-1.5">
              {result.app_name && (
                <>
                  <AppDot appName={result.app_name} size={6} />
                  <span className="text-[10px] font-mono text-accent truncate">
                    {result.app_name}
                  </span>
                </>
              )}
            </div>
            {result.window_title && (
              <p className="text-xs text-text-primary truncate leading-tight mb-1">
                {result.window_title}
              </p>
            )}
            <p className="text-[11px] text-text-secondary line-clamp-3 leading-relaxed">
              <HighlightedText html={result.matched_text} />
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
