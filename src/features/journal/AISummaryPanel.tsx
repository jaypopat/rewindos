import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { generateJournalSummary } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { dateToKey } from "@/lib/time-ranges";
import { cn } from "@/lib/utils";
import { Sparkles, RefreshCw } from "lucide-react";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek as getStartOfWeek,
  endOfWeek as getEndOfWeek,
  format,
} from "date-fns";

interface AISummaryPanelProps {
  selectedDate: Date;
}

export function AISummaryPanel({ selectedDate }: AISummaryPanelProps) {
  const [tab, setTab] = useState<"week" | "month">("week");

  const periodInfo = useMemo(() => {
    if (tab === "week") {
      const start = getStartOfWeek(selectedDate, { weekStartsOn: 1 });
      const end = getEndOfWeek(selectedDate, { weekStartsOn: 1 });
      return {
        type: "week",
        key: dateToKey(start),
        startDate: dateToKey(start),
        endDate: dateToKey(end),
      };
    }
    const start = startOfMonth(selectedDate);
    const end = endOfMonth(selectedDate);
    return {
      type: "month",
      key: format(start, "yyyy-MM"),
      startDate: dateToKey(start),
      endDate: dateToKey(end),
    };
  }, [selectedDate, tab]);

  const {
    data: summary,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: queryKeys.journalSummary(periodInfo.type, periodInfo.key),
    queryFn: () =>
      generateJournalSummary(periodInfo.type, periodInfo.key, periodInfo.startDate, periodInfo.endDate),
    staleTime: 300_000,
    retry: false,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider flex items-center gap-1.5">
          <Sparkles className="size-3" strokeWidth={2} />
          AI Summary
        </h3>
        <div className="flex gap-0.5 bg-surface-raised rounded p-0.5">
          <button
            onClick={() => setTab("week")}
            className={cn(
              "px-2 py-0.5 text-[10px] rounded transition-colors",
              tab === "week" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text-secondary",
            )}
          >
            Week
          </button>
          <button
            onClick={() => setTab("month")}
            className={cn(
              "px-2 py-0.5 text-[10px] rounded transition-colors",
              tab === "month" ? "bg-accent/15 text-accent" : "text-text-muted hover:text-text-secondary",
            )}
          >
            Month
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3">
          <div className="w-3 h-3 border border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-[10px] text-text-muted">Generating summary...</span>
        </div>
      ) : isError ? (
        <p className="text-[10px] text-text-muted italic py-2">
          No entries in this period, or Ollama unavailable.
        </p>
      ) : summary ? (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary leading-relaxed">{summary.summary_text}</p>
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <span className="font-mono">{summary.entry_count} entries</span>
            {summary.cached && <span className="text-text-muted/50">cached</span>}
            <button
              onClick={() => refetch()}
              className="ml-auto text-text-muted hover:text-accent transition-colors"
              title="Regenerate"
            >
              <RefreshCw className="size-3" strokeWidth={2} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
