import { describe, expect, it } from "vitest";
import { TOUR_STOPS } from "./tour-stops";

const VIEWS = [
  "dashboard", "history", "rewind", "search", "saved",
  "journal", "ask", "meetings", "settings",
];

describe("TOUR_STOPS", () => {
  it("has 6 stops with valid views, anchors, and copy", () => {
    expect(TOUR_STOPS).toHaveLength(6);
    for (const s of TOUR_STOPS) {
      expect(VIEWS).toContain(s.view);
      expect(s.anchor.length).toBeGreaterThan(0);
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });

  it("settings stops declare a settings tab", () => {
    for (const s of TOUR_STOPS.filter((s) => s.view === "settings")) {
      expect(s.settingsTab).toBeTruthy();
    }
  });

  it("stop ids are unique", () => {
    expect(new Set(TOUR_STOPS.map((s) => s.id)).size).toBe(TOUR_STOPS.length);
  });
});
