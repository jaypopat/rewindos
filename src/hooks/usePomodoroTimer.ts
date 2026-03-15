import { useCallback, useEffect, useReducer, useRef } from "react";

export type PomodoroPhase = "work" | "short_break" | "long_break" | "idle";

export interface PomodoroConfig {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
  autoStartBreaks: boolean;
  autoStartWork: boolean;
}

interface PomodoroState {
  phase: PomodoroPhase;
  secondsRemaining: number;
  totalSeconds: number;
  isRunning: boolean;
  completedSessions: number;
  totalWorkSeconds: number;
}

type TimerAction =
  | { type: "TICK" }
  | { type: "PHASE_COMPLETE"; config: PomodoroConfig }
  | { type: "START"; config: PomodoroConfig }
  | { type: "PAUSE" }
  | { type: "SKIP"; config: PomodoroConfig }
  | { type: "RESET"; config: PomodoroConfig };

function timerReducer(state: PomodoroState, action: TimerAction): PomodoroState {
  switch (action.type) {
    case "TICK": {
      if (state.secondsRemaining <= 1) {
        return { ...state, secondsRemaining: 0 };
      }
      return {
        ...state,
        secondsRemaining: state.secondsRemaining - 1,
        totalWorkSeconds: state.phase === "work" ? state.totalWorkSeconds + 1 : state.totalWorkSeconds,
      };
    }
    case "PHASE_COMPLETE": {
      const cfg = action.config;
      if (state.phase === "work") {
        const newCompleted = state.completedSessions + 1;
        const isLongBreak = newCompleted % cfg.sessionsBeforeLongBreak === 0;
        const nextPhase = isLongBreak ? "long_break" as const : "short_break" as const;
        const nextDuration = isLongBreak ? cfg.longBreakMinutes * 60 : cfg.shortBreakMinutes * 60;
        return {
          ...state,
          isRunning: cfg.autoStartBreaks,
          completedSessions: newCompleted,
          phase: nextPhase,
          secondsRemaining: nextDuration,
          totalSeconds: nextDuration,
        };
      }
      const workDuration = cfg.workMinutes * 60;
      return {
        ...state,
        isRunning: cfg.autoStartWork,
        phase: "work",
        secondsRemaining: workDuration,
        totalSeconds: workDuration,
      };
    }
    case "START": {
      if (state.phase === "idle") {
        const workDuration = action.config.workMinutes * 60;
        return { ...state, phase: "work", secondsRemaining: workDuration, totalSeconds: workDuration, isRunning: true };
      }
      return { ...state, isRunning: true };
    }
    case "PAUSE":
      return { ...state, isRunning: false };
    case "SKIP": {
      // Delegate to PHASE_COMPLETE logic by zeroing remaining and completing
      const cfg = action.config;
      if (state.phase === "work") {
        const newCompleted = state.completedSessions + 1;
        const isLongBreak = newCompleted % cfg.sessionsBeforeLongBreak === 0;
        const nextPhase = isLongBreak ? "long_break" as const : "short_break" as const;
        const nextDuration = isLongBreak ? cfg.longBreakMinutes * 60 : cfg.shortBreakMinutes * 60;
        return {
          ...state,
          isRunning: cfg.autoStartBreaks,
          completedSessions: newCompleted,
          phase: nextPhase,
          secondsRemaining: nextDuration,
          totalSeconds: nextDuration,
        };
      }
      const workDuration = cfg.workMinutes * 60;
      return {
        ...state,
        isRunning: cfg.autoStartWork,
        phase: "work",
        secondsRemaining: workDuration,
        totalSeconds: workDuration,
      };
    }
    case "RESET": {
      const workDuration = action.config.workMinutes * 60;
      return {
        phase: "idle",
        secondsRemaining: workDuration,
        totalSeconds: workDuration,
        isRunning: false,
        completedSessions: 0,
        totalWorkSeconds: 0,
      };
    }
  }
}

const DEFAULT_CONFIG: PomodoroConfig = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  autoStartBreaks: true,
  autoStartWork: false,
};

function createInitialState(config: PomodoroConfig): PomodoroState {
  return {
    phase: "idle",
    secondsRemaining: config.workMinutes * 60,
    totalSeconds: config.workMinutes * 60,
    isRunning: false,
    completedSessions: 0,
    totalWorkSeconds: 0,
  };
}

export function usePomodoroTimer(config: PomodoroConfig = DEFAULT_CONFIG) {
  const [state, dispatch] = useReducer(timerReducer, config, createInitialState);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  // Tick
  useEffect(() => {
    if (!state.isRunning) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    intervalRef.current = setInterval(() => {
      dispatch({ type: "TICK" });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [state.isRunning]);

  // Handle phase completion when timer reaches 0
  useEffect(() => {
    if (state.secondsRemaining === 0 && state.phase !== "idle") {
      dispatch({ type: "PHASE_COMPLETE", config: configRef.current });
    }
  }, [state.secondsRemaining, state.phase]);

  const start = useCallback(() => {
    dispatch({ type: "START", config: configRef.current });
  }, []);

  const pause = useCallback(() => {
    dispatch({ type: "PAUSE" });
  }, []);

  const skip = useCallback(() => {
    dispatch({ type: "SKIP", config: configRef.current });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "RESET", config: configRef.current });
  }, []);

  return {
    state,
    start,
    pause,
    skip,
    reset,
  };
}
