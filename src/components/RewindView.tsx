import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { browseScreenshots, getDailySummary, getImageUrl, type TimelineEntry, type DailySummary } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AppDot } from "./AppDot";
import { formatTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

interface RewindViewProps {
  onSelectScreenshot: (id: number) => void;
}

interface AppSession {
  appName: string | null;
  windowTitle: string | null;
  startTime: number;
  endTime: number;
  screenshots: TimelineEntry[];
  durationSeconds: number;
}

/**
 * Groups sequential screenshots by app into "sessions".
 * A new session starts when the app name changes or there's a gap > 60s.
 */
function groupIntoSessions(screenshots: TimelineEntry[]): AppSession[] {
  if (screenshots.length === 0) return [];

  // Screenshots come newest-first, reverse for chronological grouping
  const sorted = [...screenshots].reverse();
  const sessions: AppSession[] = [];
  let current: AppSession = {
    appName: sorted[0].app_name,
    windowTitle: sorted[0].window_title,
    startTime: sorted[0].timestamp,
    endTime: sorted[0].timestamp,
    screenshots: [sorted[0]],
    durationSeconds: 0,
  };

  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    const gap = s.timestamp - current.endTime;
    const sameApp = s.app_name === current.appName;

    if (sameApp && gap < 60) {
      // Continue current session
      current.endTime = s.timestamp;
      current.screenshots.push(s);
      current.windowTitle = s.window_title ?? current.windowTitle;
    } else {
      // Close current session and start new one
      current.durationSeconds = current.endTime - current.startTime + 5; // +5 for last capture interval
      sessions.push(current);
      current = {
        appName: s.app_name,
        windowTitle: s.window_title,
        startTime: s.timestamp,
        endTime: s.timestamp,
        screenshots: [s],
        durationSeconds: 0,
      };
    }
  }

  // Close last session
  current.durationSeconds = current.endTime - current.startTime + 5;
  sessions.push(current);

  return sessions;
}

const DAY_OPTIONS = [
  { label: "Today", offset: 0 },
  { label: "Yesterday", offset: 1 },
  { label: "2 days ago", offset: 2 },
  { label: "3 days ago", offset: 3 },
] as const;

export function RewindView({ onSelectScreenshot }: RewindViewProps) {
  const [dayOffset, setDayOffset] = useState(0);

  const { startTime, endTime } = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - dayOffset);
    d.setHours(0, 0, 0, 0);
    const start = Math.floor(d.getTime() / 1000);
    const end = start + 86400;
    return { startTime: start, endTime: end };
  }, [dayOffset]);

  const { data: screenshots = [], isLoading } = useQuery({
    queryKey: queryKeys.timeline(startTime),
    queryFn: () => browseScreenshots(startTime, endTime, undefined, 2000),
    staleTime: 30_000,
  });

  const sessions = useMemo(() => groupIntoSessions(screenshots), [screenshots]);

  // Compute daily stats
  const totalScreenTime = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const appBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const name = s.appName ?? "Unknown";
      map.set(name, (map.get(name) ?? 0) + s.durationSeconds);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [sessions]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/30 shrink-0">
        <div>
          <span className="font-display text-base text-text-primary">Rewind</span>
          {screenshots.length > 0 && (
            <span className="text-xs text-text-muted ml-2">
              {formatDuration(totalScreenTime)} screen time &middot; {sessions.length} sessions
            </span>
          )}
        </div>
        <div className="flex gap-0.5 bg-surface-raised rounded-lg p-0.5">
          {DAY_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setDayOffset(opt.offset)}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                dayOffset === opt.offset
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-text-muted hover:text-text-secondary",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && screenshots.length === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <p className="text-sm text-text-secondary">No activity recorded</p>
            <p className="text-xs text-text-muted">
              {dayOffset === 0 ? "Start the daemon to begin capturing" : "No captures on this day"}
            </p>
          </div>
        </div>
      )}

      {!isLoading && screenshots.length > 0 && (
        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-6">
            {/* AI Insights panel */}
            <AiInsightsPanel startTime={startTime} endTime={endTime} hasData={screenshots.length > 0} />

            {/* App breakdown bar */}
            {appBreakdown.length > 0 && (
              <div className="space-y-2">
                {/* Stacked bar */}
                <div className="flex h-3 rounded-full overflow-hidden bg-surface-raised">
                  {appBreakdown.map(([name, seconds]) => (
                    <div
                      key={name}
                      className="h-full first:rounded-l-full last:rounded-r-full"
                      style={{
                        width: `${(seconds / totalScreenTime) * 100}%`,
                        backgroundColor: `var(--color-app-${hashIdx(name)})`,
                        opacity: 0.8,
                      }}
                      title={`${name}: ${formatDuration(seconds)}`}
                    />
                  ))}
                </div>
                {/* Legend */}
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {appBreakdown.map(([name, seconds]) => (
                    <span key={name} className="inline-flex items-center gap-1.5 text-[11px]">
                      <AppDot appName={name} size={6} />
                      <span className="text-text-secondary">{name}</span>
                      <span className="text-text-muted font-mono tabular-nums">
                        {formatDuration(seconds)}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Session feed — newest first */}
            <div className="space-y-2">
              {[...sessions].reverse().map((session, i) => (
                <SessionCard
                  key={`${session.startTime}-${i}`}
                  session={session}
                  onSelectScreenshot={onSelectScreenshot}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function SessionCard({
  session,
  onSelectScreenshot,
}: {
  session: AppSession;
  onSelectScreenshot: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = session.screenshots.slice(0, 4);
  const remaining = session.screenshots.length - preview.length;

  return (
    <div className="bg-surface-raised/50 rounded-xl border border-border/30 overflow-hidden animate-fade-in-up">
      {/* Session header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised transition-colors text-left"
      >
        <AppDot appName={session.appName} size={8} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">
              {session.appName ?? "Unknown"}
            </span>
            {session.windowTitle && (
              <span className="text-xs text-text-muted truncate hidden sm:inline">
                — {session.windowTitle}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-[11px] text-text-muted font-mono tabular-nums">
            {formatTime(session.startTime)}
            {session.durationSeconds > 10 && ` — ${formatTime(session.endTime)}`}
          </span>
          <span className="text-[10px] text-accent/70 font-mono tabular-nums">
            {formatDuration(session.durationSeconds)}
          </span>
          <svg
            className={cn("size-3.5 text-text-muted transition-transform", expanded && "rotate-180")}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>

      {/* Thumbnail strip (always visible) */}
      <div className="flex gap-1 px-4 pb-2.5">
        {preview.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelectScreenshot(s.id)}
            className="shrink-0 w-20 h-12 rounded-md overflow-hidden border border-border/20 hover:border-accent/30 transition-colors"
          >
            {s.thumbnail_path ? (
              <img src={getImageUrl(s.thumbnail_path)} alt="" className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <div className="w-full h-full bg-surface-overlay" />
            )}
          </button>
        ))}
        {remaining > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="shrink-0 w-20 h-12 rounded-md bg-surface-overlay/50 border border-border/20 flex items-center justify-center text-[10px] text-text-muted hover:text-text-secondary transition-colors"
          >
            +{remaining} more
          </button>
        )}
      </div>

      {/* Expanded: all screenshots */}
      {expanded && remaining > 0 && (
        <div className="flex flex-wrap gap-1 px-4 pb-3">
          {session.screenshots.slice(4).map((s) => (
            <button
              key={s.id}
              onClick={() => onSelectScreenshot(s.id)}
              className="shrink-0 w-20 h-12 rounded-md overflow-hidden border border-border/20 hover:border-accent/30 transition-colors"
            >
              {s.thumbnail_path ? (
                <img src={getImageUrl(s.thumbnail_path)} alt="" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full bg-surface-overlay" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AiInsightsPanel({
  startTime,
  endTime,
  hasData,
}: {
  startTime: number;
  endTime: number;
  hasData: boolean;
}) {
  const queryClient = useQueryClient();

  // Cache the summary per day
  const { data: cached } = useQuery<DailySummary>({
    queryKey: queryKeys.dailySummary(startTime),
    enabled: false, // Manual fetch only
  });

  const { mutate: generate, isPending, error } = useMutation({
    mutationFn: () => getDailySummary(startTime, endTime),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.dailySummary(startTime), data);
    },
  });

  if (!hasData) return null;

  // Show the summary if we have it
  if (cached) {
    return (
      <div className="bg-surface-raised/60 rounded-xl border border-amber-500/20 overflow-hidden animate-fade-in-up">
        <div className="px-4 py-3 border-b border-amber-500/10 flex items-center gap-2">
          <svg className="size-4 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
          </svg>
          <span className="text-xs font-medium text-amber-400">AI Daily Insights</span>
          <button
            onClick={() => generate()}
            className="ml-auto text-[10px] text-text-muted hover:text-amber-400 transition-colors"
          >
            Regenerate
          </button>
        </div>
        <div className="px-4 py-3">
          <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
            {cached.summary}
          </p>
        </div>
      </div>
    );
  }

  // Show generate button
  return (
    <div className="bg-surface-raised/40 rounded-xl border border-border/30 overflow-hidden">
      <button
        onClick={() => generate()}
        disabled={isPending}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-surface-raised/60 transition-colors disabled:opacity-60"
      >
        {isPending ? (
          <div className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin" />
        ) : (
          <svg className="size-4 text-amber-400/70" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456Z" />
          </svg>
        )}
        <div className="text-left">
          <span className="text-sm text-text-secondary">
            {isPending ? "Analyzing your day..." : "Generate AI insights"}
          </span>
          {!isPending && (
            <span className="block text-[10px] text-text-muted">
              Uses local Ollama to summarize your activity
            </span>
          )}
        </div>
      </button>
      {error && (
        <div className="px-4 pb-3">
          <p className="text-xs text-red-400">
            {error instanceof Error ? error.message : "Failed to generate summary"}
          </p>
        </div>
      )}
    </div>
  );
}

function hashIdx(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h += name.charCodeAt(i);
  return h % 12;
}
