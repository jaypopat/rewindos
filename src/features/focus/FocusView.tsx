import { useEffect, useState } from "react";
import { usePomodoroTimer, type PomodoroConfig, type PomodoroPhase } from "@/hooks/usePomodoroTimer";
import { useFocusScore } from "@/hooks/useFocusScore";
import { getConfig } from "@/lib/api";
import { type AppConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { getCategoryColor, buildCategoryRules } from "@/lib/app-categories";

function phaseLabel(phase: PomodoroPhase): string {
  switch (phase) {
    case "work": return "focus";
    case "short_break": return "short break";
    case "long_break": return "long break";
    case "idle": return "ready";
  }
}

function phaseColor(phase: PomodoroPhase): string {
  switch (phase) {
    case "work": return "text-accent";
    case "short_break": return "text-signal-active";
    case "long_break": return "text-semantic";
    case "idle": return "text-text-muted";
  }
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function FocusView() {
  const [focusSettings, setFocusSettings] = useState({
    config: {
      workMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      sessionsBeforeLongBreak: 4,
      autoStartBreaks: true,
      autoStartWork: false,
    } as PomodoroConfig,
    distractionApps: [] as string[],
    categoryRules: undefined as Record<string, string[]> | undefined,
    dailyGoalMinutes: 480,
  });

  const { config, distractionApps, categoryRules, dailyGoalMinutes } = focusSettings;

  // Load config from backend (single fetch)
  useEffect(() => {
    getConfig().then((c) => {
      const { focus } = c as unknown as AppConfig;
      if (focus) {
        const userRules = focus.category_rules ?? {};
        setFocusSettings({
          config: {
            workMinutes: focus.work_minutes ?? 25,
            shortBreakMinutes: focus.short_break_minutes ?? 5,
            longBreakMinutes: focus.long_break_minutes ?? 15,
            sessionsBeforeLongBreak: focus.sessions_before_long_break ?? 4,
            autoStartBreaks: focus.auto_start_breaks ?? true,
            autoStartWork: focus.auto_start_work ?? false,
          },
          distractionApps: focus.distraction_apps ?? [],
          categoryRules: Object.keys(userRules).length > 0 ? buildCategoryRules(userRules) : undefined,
          dailyGoalMinutes: focus.daily_goal_minutes ?? 480,
        });
      }
    }).catch(() => {});
  }, []);

  const { state, start, pause, skip, reset } = usePomodoroTimer(config);
  const focus = useFocusScore(distractionApps, categoryRules);

  const progress = state.totalSeconds > 0
    ? ((state.totalSeconds - state.secondsRemaining) / state.totalSeconds) * 100
    : 0;

  const dailyProgress = Math.min(100, (focus.productiveMinutes / dailyGoalMinutes) * 100);

  // Ring dimensions
  const ringSize = 200;
  const strokeWidth = 4;
  const radius = (ringSize - strokeWidth * 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (progress / 100) * circumference;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <div className={cn("w-1.5 h-1.5", state.isRunning ? "bg-signal-active animate-pulse" : "bg-text-muted")} />
          <span className="font-mono text-xs text-text-muted uppercase tracking-wider">focus</span>
          {state.completedSessions > 0 && (
            <span className="font-mono text-[10px] text-text-muted">
              {state.completedSessions} session{state.completedSessions !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {(state.phase !== "idle" || state.completedSessions > 0) && (
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11px] text-text-muted hover:text-text-secondary border border-border/50 hover:border-border transition-all"
          >
            reset
          </button>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-8">
        {/* Timer ring */}
        <div className="relative animate-fade-in">
          <svg width={ringSize} height={ringSize} className="rotate-[-90deg]">
            {/* Background ring */}
            <circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-border/30"
            />
            {/* Progress ring */}
            {state.phase !== "idle" && (
              <circle
                cx={ringSize / 2}
                cy={ringSize / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className={cn(
                  "transition-all duration-1000",
                  state.phase === "work" ? "text-accent" : state.phase === "short_break" ? "text-signal-active" : "text-semantic",
                )}
              />
            )}
          </svg>

          {/* Center content */}
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn("font-mono text-4xl tracking-tight", phaseColor(state.phase))}>
              {formatTimer(state.secondsRemaining)}
            </span>
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mt-1">
              {phaseLabel(state.phase)}
            </span>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {!state.isRunning ? (
            <button
              onClick={start}
              className="flex items-center justify-center w-12 h-12 border border-accent/40 bg-accent/10 hover:bg-accent/20 transition-all group"
            >
              <svg className="size-5 text-accent" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={pause}
              className="flex items-center justify-center w-12 h-12 border border-semantic/40 bg-semantic/10 hover:bg-semantic/20 transition-all group"
            >
              <svg className="size-5 text-semantic" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 4h4v16H6zm8 0h4v16h-4z" />
              </svg>
            </button>
          )}

          {state.phase !== "idle" && (
            <button
              onClick={skip}
              className="flex items-center justify-center w-10 h-10 border border-border/50 hover:border-border bg-surface-raised/30 hover:bg-surface-raised/50 transition-all"
            >
              <svg className="size-4 text-text-muted" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061A1.125 1.125 0 0 1 3 16.811V8.69ZM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061a1.125 1.125 0 0 1-1.683-.977V8.69Z" />
              </svg>
            </button>
          )}
        </div>

        {/* Session progress dots */}
        <div className="flex items-center gap-2">
          {Array.from({ length: config.sessionsBeforeLongBreak }).map((_, i) => (
            <div
              key={i}
              className={cn(
                "w-2 h-2 transition-all",
                i < (state.completedSessions % config.sessionsBeforeLongBreak)
                  ? "bg-accent"
                  : i === (state.completedSessions % config.sessionsBeforeLongBreak) && state.phase === "work"
                    ? "bg-accent/30 animate-pulse"
                    : "bg-border/40",
              )}
            />
          ))}
          <span className="font-mono text-[10px] text-text-muted ml-1">
            {state.completedSessions % config.sessionsBeforeLongBreak}/{config.sessionsBeforeLongBreak}
          </span>
        </div>

        {/* Stats grid */}
        <div className="w-full max-w-md grid grid-cols-3 gap-3 animate-fade-in" style={{ animationDelay: "100ms" }}>
          {/* App switches */}
          <div className="border border-border/50 bg-surface-raised/30 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 bg-accent" />
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">switches</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display text-3xl text-text-primary">
                {focus.isLoading ? "--" : focus.appSwitches}
              </span>
              <span className="font-mono text-xs text-text-muted">today</span>
            </div>
          </div>

          {/* Productive time */}
          <div className="border border-border/50 bg-surface-raised/30 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 bg-accent" />
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">productive</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display text-3xl text-text-primary">
                {focus.isLoading ? "--" : `${Math.floor(focus.productiveMinutes / 60)}h${focus.productiveMinutes % 60}m`}
              </span>
            </div>
          </div>

          {/* Distraction time */}
          <div className="border border-border/50 bg-surface-raised/30 px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 bg-signal-error" />
              <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">distracted</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-display text-3xl text-signal-error/80">
                {focus.isLoading ? "--" : `${focus.distractionMinutes}m`}
              </span>
            </div>
          </div>
        </div>

        {/* Daily goal bar */}
        <div className="w-full max-w-md animate-fade-in" style={{ animationDelay: "200ms" }}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">daily goal</span>
            <span className="font-mono text-[10px] text-text-muted">
              {focus.isLoading ? "--" : focus.productiveMinutes}m / {dailyGoalMinutes}m
            </span>
          </div>
          <div className="w-full h-1.5 bg-border/30 overflow-hidden">
            <div
              className="h-full bg-accent transition-all duration-500"
              style={{ width: `${focus.isLoading ? 0 : dailyProgress}%` }}
            />
          </div>
        </div>

        {/* Category breakdown */}
        {!focus.isLoading && Object.keys(focus.categoryBreakdown).length > 0 && (
          <div className="w-full max-w-md animate-fade-in" style={{ animationDelay: "300ms" }}>
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">
              activity breakdown
            </span>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {Object.entries(focus.categoryBreakdown)
                .filter(([, mins]) => mins > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([category, mins]) => (
                  <div
                    key={category}
                    className="flex items-center gap-2 px-3 py-2 border border-border/50 bg-surface-raised/30"
                  >
                    <span
                      className="w-2 h-2 shrink-0"
                      style={{ backgroundColor: getCategoryColor(category) }}
                    />
                    <span className="text-xs text-text-secondary flex-1">{category}</span>
                    <span className="font-mono text-xs text-text-muted tabular-nums">
                      {mins >= 60
                        ? `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ""}`
                        : `${mins}m`}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Top app indicator */}
        {focus.topApp && (
          <div className="flex items-center gap-2 animate-fade-in" style={{ animationDelay: "400ms" }}>
            <span className="font-mono text-[10px] text-text-muted">most used:</span>
            <span className="font-mono text-xs text-text-secondary">{focus.topApp}</span>
          </div>
        )}
      </div>
    </div>
  );
}
