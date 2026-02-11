// Known browser app names (lowercase) for domain extraction
const BROWSERS = new Set([
  "firefox",
  "mozilla firefox",
  "google chrome",
  "google-chrome",
  "chromium",
  "brave",
  "brave browser",
  "microsoft edge",
  "vivaldi",
  "opera",
  "zen",
  "zen browser",
]);

// Known terminal app names (lowercase) for command extraction
const TERMINALS = new Set([
  "ghostty", "alacritty", "kitty", "wezterm", "foot", "rio", "warp",
  "konsole", "gnome-terminal", "tilix", "xterm", "st", "urxvt",
  "yakuake", "guake", "sakura", "terminator", "hyper", "terminal",
]);

// App name suffixes to strip (order matters — try longer patterns first)
const APP_SUFFIXES = [
  " — Mozilla Firefox",
  " - Mozilla Firefox",
  " — Google Chrome",
  " - Google Chrome",
  " – Chromium",
  " - Chromium",
  " — Brave",
  " - Brave",
  " — Microsoft Edge",
  " - Microsoft Edge",
  " — Vivaldi",
  " - Vivaldi",
  " — Opera",
  " - Opera",
  " — Zen Browser",
  " - Zen Browser",
  " - FreeTube",
  " — FreeTube",
  " - Obsidian",
  " — Obsidian",
  " - Notion",
  " — Notion",
  " - Discord",
  " — Discord",
  " - Slack",
  " — Slack",
  " - Telegram",
  " — Telegram",
  " - Signal",
  " — Signal",
];

// Notification count prefix pattern: "(1) ", "(23) ", etc.
const NOTIFICATION_PREFIX = /^\(\d+\)\s+/;
// Unsaved marker prefix: "* " or "● "
const UNSAVED_PREFIX = /^[*●]\s+/;

/**
 * Extract a meaningful short label from a raw window title.
 *
 * Rules applied in order:
 * 1. Strip app name suffixes (e.g. " — Mozilla Firefox")
 * 2. Strip common prefixes (notification counts, unsaved markers)
 * 3. For browsers: extract domain from "Page Title - domain.com" patterns
 * 4. For IDEs: extract filename from "filename.ext — ProjectName — VS Code" patterns
 * 5. Truncate to 60 chars with ellipsis if still too long
 */
export function parseWindowTitle(title: string, appName?: string): string {
  if (!title) return title;

  let result = title;

  // 1. Strip known app name suffixes
  for (const suffix of APP_SUFFIXES) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }

  // 2. Strip common prefixes
  result = result.replace(NOTIFICATION_PREFIX, "");
  result = result.replace(UNSAVED_PREFIX, "");

  const appLower = (appName ?? "").toLowerCase();

  // 3. For terminals: extract the command (strip hostname prefix)
  if (TERMINALS.has(appLower)) {
    result = extractTerminalTitle(result);
  }

  // 4. For browsers: try to extract domain
  if (BROWSERS.has(appLower)) {
    result = extractBrowserTitle(result);
  }

  // 5. For IDEs: extract filename
  if (isIDE(appLower)) {
    result = extractIDETitle(result);
  }

  // 6. Truncate
  if (result.length > 60) {
    result = result.slice(0, 57) + "...";
  }

  return result.trim() || title;
}

/**
 * For terminal titles, strip hostname/user prefixes.
 * Common patterns:
 * - "hostname | command args"  (e.g. "effulgent-apricot | cargo run -p rewindos-daemon")
 * - "user@hostname: ~/path"   (e.g. "jay@desktop: ~/Dev/rewindos")
 * - "hostname:~/path"
 * - "fish /home/user/path"    (shell name + cwd)
 */
function extractTerminalTitle(title: string): string {
  // Pattern: "hostname | command" — pipe separator with spaces
  const pipeIdx = title.indexOf(" | ");
  if (pipeIdx > 0 && pipeIdx < 40) {
    const after = title.slice(pipeIdx + 3).trim();
    if (after.length > 0) return after;
  }

  // Pattern: "user@host: path" or "user@host:path"
  const atHostMatch = title.match(/^\w+@[\w.-]+:\s*(.*)/);
  if (atHostMatch && atHostMatch[1]) {
    const path = atHostMatch[1];
    // Shorten home directory paths
    return path.replace(/^~\//, "~/");
  }

  // Pattern: "hostname:~/path" (no user@)
  const hostPathMatch = title.match(/^[\w.-]+:(~?\/.*)$/);
  if (hostPathMatch && hostPathMatch[1]) {
    return hostPathMatch[1];
  }

  return title;
}

/** For browser titles like "Page Title - domain.com", extract domain */
function extractBrowserTitle(title: string): string {
  // Many browser tabs: "Page Title - site.com" or "Page Title · site.com"
  // Try to find a domain-like suffix after the last separator
  const separators = [" - ", " · ", " | "];
  for (const sep of separators) {
    const lastIdx = title.lastIndexOf(sep);
    if (lastIdx > 0) {
      const after = title.slice(lastIdx + sep.length).trim();
      // Check if it looks like a domain (has dot, no spaces)
      if (/^[a-zA-Z0-9][\w.-]+\.[a-zA-Z]{2,}$/.test(after)) {
        return after;
      }
    }
  }
  return title;
}

/** Check if app name looks like an IDE */
function isIDE(appLower: string): boolean {
  return (
    appLower.includes("code") ||
    appLower.includes("vs code") ||
    appLower.includes("visual studio") ||
    appLower === "zed" ||
    appLower === "neovim" ||
    appLower === "nvim" ||
    appLower.includes("intellij") ||
    appLower.includes("webstorm") ||
    appLower.includes("pycharm") ||
    appLower.includes("clion") ||
    appLower.includes("rider") ||
    appLower.includes("goland") ||
    appLower.includes("rustrover") ||
    appLower.includes("sublime")
  );
}

/** For IDE titles like "file.ts — project — VS Code", extract the filename */
function extractIDETitle(title: string): string {
  // VS Code pattern: "filename.ext — ProjectName — Visual Studio Code"
  // or "filename.ext - ProjectName - Visual Studio Code"
  // The app suffix should already be stripped, so we have "filename.ext — ProjectName"
  const separators = [" — ", " - ", " – "];
  for (const sep of separators) {
    const idx = title.indexOf(sep);
    if (idx > 0) {
      const before = title.slice(0, idx).trim();
      // If the first segment looks like a filename (has extension), use it
      if (/\.\w{1,10}$/.test(before)) {
        return before;
      }
    }
  }
  return title;
}
