import { useQuery } from "@tanstack/react-query";
import { search } from "@/lib/api";
import type { SearchFilters } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchResultCard } from "./SearchResultCard";
import { SearchResultGrid } from "./SearchResultGrid";
import { ViewToggle } from "./ViewToggle";
import { SemanticBadge } from "./SemanticBadge";
import { formatNumber } from "@/lib/format";
import { Search } from "lucide-react";

interface SearchResultsProps {
  query: string;
  filters: SearchFilters;
  onSelectResult: (id: number) => void;
  resultView: "grid" | "list";
  onResultViewChange: (view: "grid" | "list") => void;
}

export function SearchResults({ query, filters, onSelectResult, resultView, onResultViewChange }: SearchResultsProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.search(query, filters),
    queryFn: () => search(query, filters),
    enabled: query.length > 0,
  });

  // Empty state — no query
  if (!query) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center space-y-3 animate-fade-in">
          <Search className="h-12 w-12 mx-auto text-accent/25" strokeWidth={0.8} />
          <p className="font-display text-xl text-text-primary">
            Everything you've seen, one line away.
          </p>
          <p className="text-xs text-text-muted">
            Press <kbd className="px-1.5 py-0.5 bg-surface-raised border border-line-2 rounded text-[10px] font-mono">/</kbd> to focus
            · <kbd className="px-1.5 py-0.5 bg-surface-raised border border-line-2 rounded text-[10px] font-mono">⌘K</kbd> for quick recall
          </p>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex-1 px-5 py-3 space-y-2">
        {["a", "b", "c"].map((id) => (
          <div key={id} className="flex items-start gap-4 px-4 py-3">
            <Skeleton className="w-28 h-[72px]" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center space-y-1">
          <p className="text-sm text-signal-error">Search failed</p>
          <p className="text-xs text-text-muted">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  // No results
  if (!data || data.results.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center space-y-1 animate-fade-in">
          <p className="text-sm text-text-secondary">No matches found</p>
          <p className="text-xs text-text-muted">Try a different search term</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="px-14 pt-5 pb-20 max-w-[1180px] mx-auto w-full">
        {/* Meta line */}
        <div className="flex items-baseline gap-3.5 mb-1.5">
          <span className="kicker">Results for “{query}”</span>
          <SemanticBadge mode={data.search_mode} />
          <span className="ml-auto flex items-center gap-4">
            <span className="font-mono text-[10.5px] text-text-faint">
              {formatNumber(data.total_count)} match{data.total_count !== 1 ? "es" : ""}
            </span>
            <ViewToggle view={resultView} onViewChange={onResultViewChange} />
          </span>
        </div>

        {/* Results */}
        {resultView === "grid" ? (
          <div className="mt-4">
            <SearchResultGrid results={data.results} onSelectResult={onSelectResult} />
          </div>
        ) : (
          <div className="border-t border-line">
            {data.results.map((result, i) => (
              <SearchResultCard
                key={result.id}
                result={result}
                index={i}
                onClick={() => onSelectResult(result.id)}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
