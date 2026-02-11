import { useCallback, useEffect, useRef, useState } from "react";

export type PomodoroPhase = "work" | "short_break" | "long_break" | "idle";

export interface PomodoroConfig {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
  autoStartBreaks: boolean;
  autoStartWork: boolean;
}

export interface PomodoroState {
  phase: PomodoroPhase;
  secondsRemaining: number;
  totalSeconds: number;
  isRunning: boolean;
  completedSessions: number;
  totalWorkSeconds: number;
}

const DEFAULT_CONFIG: PomodoroConfig = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  autoStartBreaks: true,
  autoStartWork: false,
};

export function usePomodoroTimer(config: PomodoroConfig = DEFAULT_CONFIG) {
  const [phase, setPhase] = useState<PomodoroPhase>("idle");
  const [secondsRemaining, setSecondsRemaining] = useState(config.workMinutes * 60);
  const [totalSeconds, setTotalSeconds] = useState(config.workMinutes * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [completedSessions, setCompletedSessions] = useState(0);
  const [totalWorkSeconds, setTotalWorkSeconds] = useState(0);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // Tick
  useEffect(() => {
    if (!isRunning) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          // Phase complete
          handlePhaseComplete();
          return 0;
        }
        return prev - 1;
      });

      // Track work time
      if (phase === "work") {
        setTotalWorkSeconds((prev) => prev + 1);
      }
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, phase]);

  const handlePhaseComplete = useCallback(() => {
    const cfg = configRef.current;
    setIsRunning(false);

    if (phase === "work") {
      const newCompleted = completedSessions + 1;
      setCompletedSessions(newCompleted);

      // Determine next break type
      const isLongBreak = newCompleted % cfg.sessionsBeforeLongBreak === 0;
      const nextPhase = isLongBreak ? "long_break" : "short_break";
      const nextDuration = isLongBreak
        ? cfg.longBreakMinutes * 60
        : cfg.shortBreakMinutes * 60;

      setPhase(nextPhase);
      setSecondsRemaining(nextDuration);
      setTotalSeconds(nextDuration);

      if (cfg.autoStartBreaks) {
        setIsRunning(true);
      }
    } else {
      // Break finished → back to work
      const workDuration = cfg.workMinutes * 60;
      setPhase("work");
      setSecondsRemaining(workDuration);
      setTotalSeconds(workDuration);

      if (cfg.autoStartWork) {
        setIsRunning(true);
      }
    }
  }, [phase, completedSessions]);

  const start = useCallback(() => {
    if (phase === "idle") {
      const workDuration = configRef.current.workMinutes * 60;
      setPhase("work");
      setSecondsRemaining(workDuration);
      setTotalSeconds(workDuration);
    }
    setIsRunning(true);
  }, [phase]);

  const pause = useCallback(() => {
    setIsRunning(false);
  }, []);

  const skip = useCallback(() => {
    setSecondsRemaining(0);
    handlePhaseComplete();
  }, [handlePhaseComplete]);

  const reset = useCallback(() => {
    setIsRunning(false);
    setPhase("idle");
    setSecondsRemaining(configRef.current.workMinutes * 60);
    setTotalSeconds(configRef.current.workMinutes * 60);
    setCompletedSessions(0);
    setTotalWorkSeconds(0);
  }, []);

  return {
    state: {
      phase,
      secondsRemaining,
      totalSeconds,
      isRunning,
      completedSessions,
      totalWorkSeconds,
    } satisfies PomodoroState,
    start,
    pause,
    skip,
    reset,
  };
}
