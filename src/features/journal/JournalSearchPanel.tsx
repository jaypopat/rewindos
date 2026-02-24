import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchJournal } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useDebounce } from "@/hooks/useDebounce";
import { Search, X } from "lucide-react";
import { MOOD_EMOJIS } from "./constants";

interface JournalSearchPanelProps {
  onNavigate: (date: string) => void;
  onClose: () => void;
}

export function JournalSearchPanel({ onNavigate, onClose }: JournalSearchPanelProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 300);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: results, isLoading } = useQuery({
    queryKey: queryKeys.journalSearch(debouncedQuery),
    queryFn: () => searchJournal(debouncedQuery, 20),
    enabled: debouncedQuery.length > 0,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="border-b border-border/50 bg-surface-raised/50">
      <div className="px-5 py-2">
        <div className="flex items-center gap-2">
          <Search className="size-3.5 text-text-muted shrink-0" strokeWidth={2} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search journal entries..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted/50 focus:outline-none"
          />
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors">
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      {debouncedQuery && (
        <div className="max-h-60 overflow-y-auto border-t border-border/30">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : results && results.results.length > 0 ? (
            <div className="py-1">
              {results.results.map((r) => (
                <button
                  key={r.entry_id}
                  onClick={() => onNavigate(r.date)}
                  className="w-full text-left px-5 py-2 hover:bg-surface-overlay/50 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-medium text-text-primary">{r.date}</span>
                    {r.mood && (
                      <span className="text-xs">{MOOD_EMOJIS[(r.mood || 3) - 1]}</span>
                    )}
                    <span className="text-[10px] text-text-muted font-mono">{r.word_count}w</span>
                  </div>
                  <div
                    className="text-xs text-text-muted line-clamp-2 [&_mark]:bg-accent/30 [&_mark]:text-text-primary"
                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                  />
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-xs text-text-muted">No results found</div>
          )}
        </div>
      )}
    </div>
  );
}
