import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getDailySummary } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { AppDot } from "./AppDot";
import { getAppColor } from "@/lib/app-colors";
import { Sparkles, ChevronDown, RefreshCw } from "lucide-react";

interface DailyDigestCardProps {
  dateKey: string;
  startTime: number;
  endTime: number;
  isToday?: boolean;
  defaultExpanded?: boolean;
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function DailyDigestCard({
  dateKey,
  startTime,
  endTime,
  isToday = false,
  defaultExpanded = false,
}: DailyDigestCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const queryClient = useQueryClient();

  const [isRegenerating, setIsRegenerating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.dailySummary(dateKey),
    queryFn: () => getDailySummary(startTime, endTime),
    staleTime: 5 * 60_000,
    enabled: isExpanded,
  });

  const handleRegenerate = async () => {
    setIsRegenerating(true);
    try {
      const fresh = await getDailySummary(startTime, endTime, true);
      queryClient.setQueryData(queryKeys.dailySummary(dateKey), fresh);
    } catch (err) {
      console.error("Failed to regenerate summary:", err);
    } finally {
      setIsRegenerating(false);
    }
  };

  const busy = isLoading || isRegenerating;

  const totalMinutes = data?.app_breakdown.reduce((sum, a) => sum + a.minutes, 0) ?? 0;

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-raised/40 transition-colors text-left"
      >
        <Sparkles className="size-4 text-amber-400 shrink-0" strokeWidth={1.5} />
        <span className="text-sm font-medium text-text-primary">Daily Digest</span>
        <span className="text-xs text-text-muted">{dateKey}</span>
        <span className="flex-1" />
        {data?.cached && (
          <span className="text-[10px] text-text-muted font-mono">cached</span>
        )}
        <ChevronDown className={`size-3.5 text-text-muted transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`} strokeWidth={2} />
      </button>

      {/* Body */}
      {isExpanded && (
        <div className="px-4 pb-3 pt-1 space-y-3">
          {/* Loading state */}
          {isLoading && !data && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <div className="w-3 h-3 border border-accent/40 border-t-accent rounded-full animate-spin" />
                <span>Generating with AI...</span>
              </div>
              <div className="space-y-1.5 animate-pulse">
                <div className="h-3 bg-surface-raised rounded w-full" />
                <div className="h-3 bg-surface-raised rounded w-5/6" />
                <div className="h-3 bg-surface-raised rounded w-4/6" />
              </div>
            </div>
          )}

          {/* Content */}
          {data != null && (
            <>
              {/* AI Summary */}
              {data.summary ? (
                <p className="text-sm text-text-secondary leading-relaxed">
                  {data.summary}
                </p>
              ) : (
                <p className="text-sm text-text-muted italic">
                  AI summary unavailable — showing app breakdown only.
                </p>
              )}

              {/* App breakdown bar */}
              {data.app_breakdown.length > 0 && totalMinutes > 0 && (
                <div>
                  <div className="flex h-2.5 rounded-full overflow-hidden bg-surface-raised">
                    {data.app_breakdown.map((app) => {
                      const pct = (app.minutes / totalMinutes) * 100;
                      if (pct < 1) return null;
                      return (
                        <div
                          key={app.app_name}
                          className="h-full first:rounded-l-full last:rounded-r-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: getAppColor(app.app_name),
                            opacity: 0.85,
                          }}
                          title={`${app.app_name}: ${app.minutes}m (${app.session_count} sessions)`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-4 flex-wrap mt-1.5">
                    {data.app_breakdown.slice(0, 6).map((app) => (
                      <div key={app.app_name} className="flex items-center gap-1.5">
                        <AppDot appName={app.app_name} size={6} />
                        <span className="text-[11px] text-text-secondary">{app.app_name}</span>
                        <span className="text-[10px] text-text-muted font-mono tabular-nums">
                          {app.minutes >= 60
                            ? `${Math.floor(app.minutes / 60)}h ${Math.round(app.minutes % 60)}m`
                            : `${Math.round(app.minutes)}m`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center gap-3 pt-1">
                <span className="text-[10px] text-text-muted font-mono">
                  {data.total_sessions} session{data.total_sessions !== 1 ? "s" : ""}
                </span>
                {data.generated_at && (
                  <span className="text-[10px] text-text-muted font-mono">
                    Generated {timeAgo(data.generated_at)}
                  </span>
                )}
                <span className="flex-1" />
                {isToday && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRegenerate();
                    }}
                    disabled={busy}
                    className="flex items-center gap-1 text-[10px] text-accent hover:text-accent/80 font-medium transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3 ${isRegenerating ? "animate-spin" : ""}`} strokeWidth={2} />
                    Regenerate
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
