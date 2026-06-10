import { describe, it, expect } from "vitest";
import { parseFragments } from "./recall-parse";

const APPS = ["ghostty", "zen", "zed-editor", "discord", "spectacle"];
// A fixed Saturday 14:00 local time
const NOW = new Date(2026, 5, 6, 14, 0, 0);

describe("parseFragments", () => {
  it("parses app, time, and content fragments together", () => {
    const f = parseFragments("pricing table in zen last week", APPS, NOW);
    expect(f.app).toBe("zen");
    expect(f.timeLabel).toBe("last week");
    expect(f.content).toBe("pricing table");
    expect(f.timeRange).not.toBeNull();
    expect(f.timeRange!.start).toBeLessThan(f.timeRange!.end);
  });

  it("prefix-matches app names from 3+ char words", () => {
    expect(parseFragments("error in gho", APPS, NOW).app).toBe("ghostty");
    expect(parseFragments("error in g", APPS, NOW).app).toBeNull();
  });

  it("resolves yesterday to a full-day range", () => {
    const f = parseFragments("postgres error yesterday", APPS, NOW);
    expect(f.timeLabel).toBe("yesterday");
    const dayStart = new Date(2026, 5, 5).getTime() / 1000;
    expect(f.timeRange).toEqual({ start: dayStart, end: dayStart + 86400 });
  });

  it("resolves a weekday to the most recent such day", () => {
    const f = parseFragments("figma file from monday", APPS, NOW);
    expect(f.timeLabel).toBe("monday");
    const monday = new Date(2026, 5, 1).getTime() / 1000;
    expect(f.timeRange).toEqual({ start: monday, end: monday + 86400 });
    expect(f.content).toBe("figma file");
  });

  it("returns plain content when nothing else matches", () => {
    const f = parseFragments("reciprocal rank fusion", APPS, NOW);
    expect(f.app).toBeNull();
    expect(f.timeLabel).toBeNull();
    expect(f.content).toBe("reciprocal rank fusion");
  });
});
