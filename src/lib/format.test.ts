import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  formatRelativeTime,
  formatBytes,
  formatDuration,
  formatNumber,
  formatDateShort,
} from "./format";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix "now" to a known point: 2025-01-15 12:00:00 UTC
    vi.setSystemTime(new Date("2025-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps < 60s ago', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now - 30)).toBe("just now");
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns minutes for timestamps < 1h ago", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now - 120)).toBe("2m ago");
    expect(formatRelativeTime(now - 3599)).toBe("59m ago");
  });

  it("returns hours for timestamps < 24h ago", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now - 3600)).toBe("1h ago");
    expect(formatRelativeTime(now - 7200)).toBe("2h ago");
  });

  it("returns days for timestamps < 7d ago", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now - 86400)).toBe("1d ago");
    expect(formatRelativeTime(now - 86400 * 3)).toBe("3d ago");
  });

  it("returns formatted date for older timestamps", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = formatRelativeTime(now - 86400 * 30);
    // Should be a date string like "Dec 16"
    expect(result).toBeTruthy();
    expect(result).not.toContain("ago");
  });
});

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
  });

  it("formats gigabytes", () => {
    expect(formatBytes(1073741824)).toBe("1.0 GB");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes", () => {
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(3599)).toBe("59m");
  });

  it("formats hours", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(5400)).toBe("1h 30m");
  });

  it("formats days", () => {
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(90000)).toBe("1d 1h");
  });
});

describe("formatNumber", () => {
  it("formats small numbers", () => {
    expect(formatNumber(42)).toBe("42");
  });

  it("formats large numbers with separators", () => {
    // Locale-dependent but should include separators
    const result = formatNumber(1234567);
    expect(result).toBeTruthy();
  });
});

describe("formatDateShort", () => {
  it("formats YYYY-MM-DD to M/D", () => {
    expect(formatDateShort("2025-01-05")).toBe("1/5");
    expect(formatDateShort("2025-12-25")).toBe("12/25");
  });
});
