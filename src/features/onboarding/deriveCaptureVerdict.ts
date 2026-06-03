import type { DaemonStatus } from "@/lib/api";

export type VerdictLevel = "green" | "amber" | "red" | "neutral";

export type VerdictCode =
  | "offline" | "checking" | "paused-locked" | "paused-user"
  | "paused-privacy" | "unfiltered" | "gnome-degraded"
  | "working" | "waiting" | "stalled" | "unknown";

export type VerdictAction =
  | "retry" | "resume" | "install-extension" | "recheck" | "capture-anyway";

export interface CaptureVerdict {
  code: VerdictCode;
  level: VerdictLevel;
  headline: string;
  guidance: string;
  actions: VerdictAction[];
  framesToday: number;
}

const STALL_THRESHOLD_SECONDS = 90;

const EXTENSION_ACTIONS: VerdictAction[] = ["install-extension", "recheck", "capture-anyway"];

export function deriveCaptureVerdict(
  status: DaemonStatus | null | undefined,
  isError: boolean,
): CaptureVerdict {
  if (isError) {
    return {
      code: "offline", level: "red",
      headline: "The capture daemon isn't running.",
      guidance: "Start it with:  systemctl --user start rewindos-daemon",
      actions: ["retry"], framesToday: 0,
    };
  }
  if (!status) {
    return {
      code: "checking", level: "neutral",
      headline: "Checking capture…",
      guidance: "", actions: [], framesToday: 0,
    };
  }

  const cs = status.capture_state ?? "";
  const secs = status.seconds_since_last_frame ?? null;
  const frames = status.frames_captured_today ?? 0;
  const desktop = (status.desktop ?? "").toLowerCase();
  const provider = status.window_info_provider ?? "";
  const isGnomeDegraded = desktop.includes("gnome") && (provider === "" || provider === "noop");

  if (cs === "paused_locked") {
    return {
      code: "paused-locked", level: "amber",
      headline: "Capture is paused — your session is locked.",
      guidance: "It resumes automatically when you unlock. Nothing is wrong.",
      actions: [], framesToday: frames,
    };
  }
  if (cs === "paused_user") {
    return {
      code: "paused-user", level: "neutral",
      headline: "Capture is paused.",
      guidance: "Resume to verify capture is working.",
      actions: ["resume"], framesToday: frames,
    };
  }
  if (cs === "paused_privacy") {
    return {
      code: "paused-privacy", level: "amber",
      headline: "App tracking can't be enforced, so capture is paused.",
      guidance: "Install the 'Window Calls Extended' extension so app/incognito exclusions can be applied — or capture anyway without enforcing them.",
      actions: EXTENSION_ACTIONS, framesToday: frames,
    };
  }
  if (status.unfiltered_capture && cs === "capturing") {
    return {
      code: "unfiltered", level: "amber",
      headline: "Capturing — but privacy exclusions are NOT being enforced.",
      guidance: "You chose 'capture anyway'. App and incognito exclusions aren't being applied.",
      actions: [], framesToday: frames,
    };
  }
  if (cs === "capturing" && isGnomeDegraded) {
    return {
      code: "gnome-degraded", level: "amber",
      headline: "Capturing, but app/window tracking is off.",
      guidance: "Install the 'Window Calls Extended' extension to capture app and window names.",
      actions: EXTENSION_ACTIONS, framesToday: frames,
    };
  }
  if (cs === "capturing" && secs !== null && secs <= STALL_THRESHOLD_SECONDS) {
    return {
      code: "working", level: "green",
      headline: "Capture is working.",
      guidance: "", actions: [], framesToday: frames,
    };
  }
  if (cs === "capturing" && frames === 0 && secs === null) {
    return {
      code: "waiting", level: "amber",
      headline: "Waiting for the first frame…",
      guidance: "If a screen-share prompt appears, pick your screen and choose Allow.",
      actions: [], framesToday: frames,
    };
  }
  if (cs === "stalled") {
    return {
      code: "stalled", level: "red",
      headline: "Capture started, but no frames are arriving.",
      guidance: "Grant the permission prompt if you see one, or your desktop portal may not support screen capture.",
      actions: ["retry"], framesToday: frames,
    };
  }
  return {
    code: "unknown", level: "neutral",
    headline: "Capture status unknown.",
    guidance: "Give it a moment, or retry.",
    actions: ["retry"], framesToday: frames,
  };
}
