export type ActivityCategory =
  | "Development"
  | "Browsing"
  | "Communication"
  | "Media"
  | "Productivity"
  | "System"
  | "Other";

const DEFAULT_RULES: Record<string, string[]> = {
  Development: [
    "code", "vscode", "neovim", "vim", "jetbrains", "idea", "android-studio",
    "sublime", "terminal", "konsole", "alacritty", "kitty", "wezterm",
    "gnome-terminal", "tilix", "xterm", "zed", "cursor",
    "ghostty", "foot", "rio", "warp", "hyper", "st", "urxvt", "yakuake",
    "guake", "sakura", "terminator", "emacs", "helix",
    "webstorm", "pycharm", "clion", "goland", "rustrover", "rider",
    "datagrip", "fleet", "lapce", "kakoune", "lite-xl",
    "github", "gitlab", "gitk", "lazygit", "tig",
  ],
  Browsing: [
    "firefox", "chrome", "chromium", "brave", "edge", "safari", "opera",
    "vivaldi", "zen", "epiphany", "midori", "qutebrowser", "nyxt",
  ],
  Communication: [
    "discord", "slack", "telegram", "signal", "teams", "zoom", "element",
    "thunderbird", "geary", "evolution", "mailspring", "mutt",
    "whatsapp", "wire", "jitsi", "meet",
  ],
  Media: [
    "spotify", "vlc", "mpv", "rhythmbox", "elisa", "youtube", "netflix",
    "twitch", "freetube", "celluloid", "totem", "audacity", "obs",
    "kdenlive", "shotcut", "pitivi", "lollypop", "amberol",
  ],
  Productivity: [
    "obsidian", "notion", "logseq", "libreoffice", "soffice", "figma",
    "gimp", "inkscape", "blender", "okular", "evince",
    "krita", "drawio", "excalidraw", "miro", "zotero", "calibre",
    "xournalpp", "rnote", "joplin", "standard-notes", "anytype",
  ],
  System: [
    "dolphin", "nautilus", "thunar", "nemo", "settings", "systemsettings",
    "gnome-control-center", "plasma", "kwin", "krunner", "rofi", "wofi",
    "baobab", "filemanager", "pcmanfm",
  ],
};

export const CATEGORY_COLORS: Record<ActivityCategory, string> = {
  Development: "#22d3ee",
  Browsing: "#fb923c",
  Communication: "#a78bfa",
  Media: "#f472b6",
  Productivity: "#34d399",
  System: "#71717a",
  Other: "#52525b",
};

/** Get color for any category (supports user-defined ones too) */
export function getCategoryColor(category: string): string {
  return (CATEGORY_COLORS as Record<string, string>)[category] ?? "#52525b";
}

/**
 * Merge user overrides on top of defaults.
 * User rules take priority — if a user adds "firefox" to "Media",
 * it won't match "Browsing" anymore because user rules are checked first.
 */
export function buildCategoryRules(
  userRules: Record<string, string[]>,
): Record<string, string[]> {
  // Start with defaults
  const merged: Record<string, string[]> = {};
  for (const [cat, keywords] of Object.entries(DEFAULT_RULES)) {
    merged[cat] = [...keywords];
  }

  // Merge user overrides: append user keywords, create new categories if needed
  for (const [cat, keywords] of Object.entries(userRules)) {
    if (merged[cat]) {
      // Append new keywords (deduplicated)
      const existing = new Set(merged[cat]);
      for (const kw of keywords) {
        if (!existing.has(kw)) {
          merged[cat].push(kw);
        }
      }
    } else {
      // User-defined category
      merged[cat] = [...keywords];
    }
  }

  return merged;
}

/** Classify an app name using the given rules (or defaults if none provided) */
export function categorizeApp(
  appName: string | null,
  rules?: Record<string, string[]>,
): ActivityCategory | string {
  if (!appName) return "Other";
  const lower = appName.toLowerCase();
  const effectiveRules = rules ?? DEFAULT_RULES;
  for (const [category, keywords] of Object.entries(effectiveRules)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return "Other";
}
