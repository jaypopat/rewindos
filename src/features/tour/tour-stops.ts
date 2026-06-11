import type { View } from "@/components/Sidebar";

export interface TourStop {
  id: string;
  /** Navigated to when the stop becomes active. */
  view: View;
  /** Element carrying [data-tour="<anchor>"] to spotlight. */
  anchor: string;
  /** For view === "settings": which settings tab to activate. */
  settingsTab?: "export" | "ai";
  title: string;
  /** 2–3 sentences; must read fine over an empty first-run view. */
  body: string;
}

export const TOUR_STOPS: TourStop[] = [
  {
    id: "search",
    view: "search",
    anchor: "search-input",
    title: "Find anything you've seen",
    body: "Every few seconds RewindOS captures your screen and reads the text on it. Type a few words here — or press Ctrl+Shift+Space from anywhere — and the moment comes back. With a local model installed, search understands meaning, not just keywords.",
  },
  {
    id: "ask",
    view: "ask",
    anchor: "ask-input",
    title: "Ask your screen history",
    body: "\"What was that error yesterday?\" \"How long did I spend in meetings?\" Ask in plain language — answers cite the actual screenshots they came from. Runs on a local model by default.",
  },
  {
    id: "history",
    view: "history",
    anchor: "history-header",
    title: "Your day, hour by hour",
    body: "Once RewindOS has been running, your day is laid out here chronologically — grouped by hour and app, with daily digests. Switch to Rewind to scrub through your screen like a timelapse.",
  },
  {
    id: "journal",
    view: "journal",
    anchor: "journal-header",
    title: "A journal that writes itself (almost)",
    body: "Daily notes with tags, templates, and screenshots attached. AI can draft a summary of your day from what you actually did — you just edit.",
  },
  {
    id: "export",
    view: "settings",
    settingsTab: "export",
    anchor: "export-vault",
    title: "Your memory, in your vault",
    body: "RewindOS can write a daily memory note — summary, key moments, meetings — straight into your Obsidian or Logseq vault, so your history becomes part of your notes.",
  },
  {
    id: "ai",
    view: "settings",
    settingsTab: "ai",
    anchor: "ai-provider",
    title: "AI on your terms",
    body: "Everything AI is optional and local-first — Ollama is detected automatically. Prefer LM Studio, OpenAI, OpenRouter, or your own endpoint? Connect it here. Claude Code can also plug into your history via MCP.",
  },
];
