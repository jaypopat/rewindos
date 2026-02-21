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
          <Search className="h-12 w-12 mx-auto text-accent/20" strokeWidth={0.8} />
          <p className="text-sm text-text-secondary">
            Search your screen history
          </p>
          <p className="text-xs text-text-muted">
            Press <kbd className="px-1.5 py-0.5 bg-surface-raised border border-border/50 text-[10px] font-mono">/</kbd> to focus
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
      <div className="px-5 py-3 space-y-3">
        {/* Results header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-display text-lg text-text-primary leading-none">
              {formatNumber(data.total_count)}
            </span>
            <span className="text-xs text-text-muted">
              result{data.total_count !== 1 ? "s" : ""}
            </span>
            <SemanticBadge mode={data.search_mode} />
          </div>
          <ViewToggle view={resultView} onViewChange={onResultViewChange} />
        </div>

        {/* Results */}
        {resultView === "grid" ? (
          <SearchResultGrid results={data.results} onSelectResult={onSelectResult} />
        ) : (
          <div className="space-y-1.5">
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
