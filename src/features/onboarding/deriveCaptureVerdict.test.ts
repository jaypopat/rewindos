import { describe, it, expect } from "vitest";
import { deriveCaptureVerdict } from "./deriveCaptureVerdict";
import type { DaemonStatus } from "@/lib/api";

function s(over: Partial<DaemonStatus>): DaemonStatus {
  return {
    is_capturing: true,
    frames_captured_today: 0,
    frames_deduplicated_today: 0,
    frames_ocr_pending: 0,
    uptime_seconds: 100,
    disk_usage_bytes: 0,
    last_capture_timestamp: null,
    window_info_provider: "kwin",
    desktop: "KDE Plasma",
    capture_state: "capturing",
    seconds_since_last_frame: 5,
    unfiltered_capture: false,
    ...over,
  };
}

describe("deriveCaptureVerdict", () => {
  it("daemon offline (query error) → red/offline + retry", () => {
    const v = deriveCaptureVerdict(undefined, true);
    expect(v.code).toBe("offline");
    expect(v.level).toBe("red");
    expect(v.actions).toContain("retry");
  });

  it("no data yet, no error → neutral/checking", () => {
    const v = deriveCaptureVerdict(undefined, false);
    expect(v.code).toBe("checking");
    expect(v.level).toBe("neutral");
  });

  it("X11 / unsupported session → red/unsupported, no actions", () => {
    const v = deriveCaptureVerdict(
      s({ capture_state: "unsupported_session", is_capturing: false }), false);
    expect(v.code).toBe("unsupported");
    expect(v.level).toBe("red");
    expect(v.actions).toEqual([]);
  });

  it("fresh capturing → green/working with framesToday label", () => {
    const v = deriveCaptureVerdict(s({ frames_captured_today: 42, seconds_since_last_frame: 4 }), false);
    expect(v.code).toBe("working");
    expect(v.level).toBe("green");
    expect(v.framesToday).toBe(42);
  });

  it("DAY-COUNT GUARD: many frames today but capture_state stalled → red, NOT green", () => {
    const v = deriveCaptureVerdict(
      s({ capture_state: "stalled", frames_captured_today: 500, seconds_since_last_frame: 300 }), false);
    expect(v.code).toBe("stalled");
    expect(v.level).toBe("red");
  });

  it("STALE GUARD: capturing but frame older than threshold → red/stalled, not unknown", () => {
    const v = deriveCaptureVerdict(
      s({ capture_state: "capturing", frames_captured_today: 7, seconds_since_last_frame: 200 }), false);
    expect(v.code).toBe("stalled");
    expect(v.level).toBe("red");
  });

  it("OVERRIDE GUARD: unfiltered_capture while capturing → amber/unfiltered, NEVER green", () => {
    const v = deriveCaptureVerdict(
      s({ unfiltered_capture: true, frames_captured_today: 10, seconds_since_last_frame: 3 }), false);
    expect(v.code).toBe("unfiltered");
    expect(v.level).toBe("amber");
  });

  it("pre-first-frame (capturing, 0 frames, null seconds) → amber/waiting", () => {
    const v = deriveCaptureVerdict(
      s({ frames_captured_today: 0, seconds_since_last_frame: null }), false);
    expect(v.code).toBe("waiting");
    expect(v.level).toBe("amber");
  });

  it("paused_user → neutral/paused-user + resume", () => {
    const v = deriveCaptureVerdict(s({ capture_state: "paused_user" }), false);
    expect(v.code).toBe("paused-user");
    expect(v.level).toBe("neutral");
    expect(v.actions).toContain("resume");
  });

  it("paused_locked → amber/paused-locked, benign, no actions", () => {
    const v = deriveCaptureVerdict(s({ capture_state: "paused_locked" }), false);
    expect(v.code).toBe("paused-locked");
    expect(v.level).toBe("amber");
    expect(v.actions).toEqual([]);
  });

  it("paused_privacy → amber/paused-privacy + extension actions", () => {
    const v = deriveCaptureVerdict(s({ capture_state: "paused_privacy" }), false);
    expect(v.code).toBe("paused-privacy");
    expect(v.level).toBe("amber");
    expect(v.actions).toEqual(expect.arrayContaining(["install-extension", "recheck", "capture-anyway"]));
  });

  it("GNOME + noop provider while capturing → amber/gnome-degraded, NOT green", () => {
    const v = deriveCaptureVerdict(
      s({ desktop: "GNOME", window_info_provider: "noop", frames_captured_today: 9, seconds_since_last_frame: 3 }), false);
    expect(v.code).toBe("gnome-degraded");
    expect(v.level).toBe("amber");
  });

  it("GNOME WITH extension while capturing → green/working", () => {
    const v = deriveCaptureVerdict(
      s({ desktop: "GNOME", window_info_provider: "window-calls-ext", frames_captured_today: 9, seconds_since_last_frame: 3 }), false);
    expect(v.code).toBe("working");
    expect(v.level).toBe("green");
  });
});
