/**
 * Fragment parsing for the Recall Palette: turn "pricing table in zen last week"
 * into { app: "zen", time: "last week" + range, content: "pricing table" }.
 * This makes the hybrid search legible — the user sees what was understood.
 */

export interface ParsedFragments {
  app: string | null;
  /** The matched time phrase, verbatim, for the "understood" chip. */
  timeLabel: string | null;
  timeRange: { start: number; end: number } | null;
  /** Remaining words — the "looks like" content terms fed to FTS/semantic search. */
  content: string;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return Math.floor(c.getTime() / 1000);
}

function timeRangeFor(phrase: string, now: Date): { start: number; end: number } | null {
  const today = startOfDay(now);
  const nowSecs = Math.floor(now.getTime() / 1000);
  switch (phrase) {
    case "today":
      return { start: today, end: nowSecs };
    case "yesterday":
      return { start: today - 86400, end: today };
    case "this morning":
    case "morning":
      return { start: today + 5 * 3600, end: today + 12 * 3600 };
    case "afternoon":
      return { start: today + 12 * 3600, end: today + 17 * 3600 };
    case "evening":
    case "tonight":
      return { start: today + 17 * 3600, end: today + 24 * 3600 };
    case "last week":
    case "this week":
      return { start: today - 7 * 86400, end: nowSecs };
    case "last month":
      return { start: today - 30 * 86400, end: nowSecs };
  }
  const weekday = WEEKDAYS.indexOf(phrase);
  if (weekday >= 0) {
    // Most recent such weekday, looking back 1..7 days
    let delta = (now.getDay() - weekday + 7) % 7;
    if (delta === 0) delta = 7;
    const dayStart = today - delta * 86400;
    return { start: dayStart, end: dayStart + 86400 };
  }
  return null;
}

/** Time phrases ordered longest-first so "last week" wins over "week". */
const TIME_PHRASES = [
  "this morning",
  "last week",
  "this week",
  "last month",
  "yesterday",
  "today",
  "morning",
  "afternoon",
  "evening",
  "tonight",
  ...WEEKDAYS,
];

const STOP_WORDS = new Set(["in", "on", "at", "the", "a", "an", "from", "that", "i", "was"]);

export function parseFragments(
  query: string,
  appNames: string[],
  now: Date = new Date(),
): ParsedFragments {
  const lower = query.toLowerCase();

  let timeLabel: string | null = null;
  let timeRange: ParsedFragments["timeRange"] = null;
  let remainder = lower;
  for (const phrase of TIME_PHRASES) {
    if (lower.includes(phrase)) {
      const range = timeRangeFor(phrase, now);
      if (range) {
        timeLabel = phrase;
        timeRange = range;
        remainder = remainder.replace(phrase, " ");
        break;
      }
    }
  }

  const words = remainder.split(/\s+/).filter(Boolean);
  let app: string | null = null;
  let appWord: string | null = null;
  for (const w of words) {
    if (w.length < 3) continue;
    const hit = appNames.find((a) => a.toLowerCase().startsWith(w));
    if (hit) {
      app = hit;
      appWord = w;
      break;
    }
  }

  const content = words
    .filter((w) => w !== appWord && !STOP_WORDS.has(w))
    .join(" ");

  return { app, timeLabel, timeRange, content };
}
