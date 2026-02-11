import type { SearchResult } from "@/lib/api";
import { getImageUrl } from "@/lib/api";
import { AppDot } from "./AppDot";
import { formatRelativeTime } from "@/lib/format";

interface SearchResultCardProps {
  result: SearchResult;
  index: number;
  onClick: () => void;
}

export function SearchResultCard({ result, index, onClick }: SearchResultCardProps) {
  return (
    <button
      onClick={onClick}
      className="animate-fade-in-up w-full flex items-start gap-4 px-4 py-3 bg-surface-raised/50 border border-border/30 hover:border-accent/30 hover:bg-surface-raised transition-all cursor-pointer text-left group"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail */}
      {result.thumbnail_path && (
        <div className="shrink-0 w-28 h-[72px] overflow-hidden bg-surface-overlay">
          <img
            src={getImageUrl(result.thumbnail_path)}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </div>
      )}

      {/* Content */}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted font-mono tabular-nums">
            {formatRelativeTime(result.timestamp)}
          </span>
          {result.app_name && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-text-secondary">
              <AppDot appName={result.app_name} size={6} />
              {result.app_name}
            </span>
          )}
        </div>

        {result.window_title && (
          <p className="text-sm text-text-primary truncate leading-tight">
            {result.window_title}
          </p>
        )}

        <p
          className="text-xs text-text-secondary line-clamp-2 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: result.matched_text }}
        />
      </div>
    </button>
  );
}
