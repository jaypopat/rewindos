import type { SearchResult } from "@/lib/api";
import { getImageUrl } from "@/lib/api";
import { AppDot } from "./AppDot";
import { formatRelativeTime } from "@/lib/format";

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
                <svg className="size-8 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                </svg>
              </div>
            )}
            {result.group_count && result.group_count > 1 && (
              <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-surface/80 backdrop-blur-sm border border-border/40 text-[10px] font-mono text-text-secondary">
                +{result.group_count - 1} similar
              </span>
            )}
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
            <p
              className="text-[11px] text-text-secondary line-clamp-3 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: result.matched_text }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}
