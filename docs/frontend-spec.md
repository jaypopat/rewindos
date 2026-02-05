# RewindOS - Frontend Specification

## Overview

Minimal search-focused UI built with React 19 + TypeScript + shadcn/ui + Tailwind CSS.
Runs inside Tauri v2 window. Communicates with Rust backend via `invoke()`.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│ RewindOS                              [⏸ Capturing] [─] │ ← Header bar
├─────────────────────────────────────────────────────────┤
│                                                          │
│  🔍 [Search your screen history...        ] [App ▾] [📅]│ ← Search bar
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ Results (142 matches)                               │ │
│  │                                                     │ │
│  │ ┌──────┐ Today, 2:34 PM · Firefox                  │ │
│  │ │thumb │ Stack Overflow - How to fix <mark>Postgre  │ │
│  │ │      │ SQL</mark> connection pool timeout...      │ │
│  │ └──────┘                                            │ │
│  │ ─────────────────────────────────────────────────── │ │
│  │ ┌──────┐ Today, 1:12 PM · VS Code                  │ │
│  │ │thumb │ db.rs - rewindos · "let pool = <mark>Post  │ │
│  │ │      │ greSQL</mark>::connect(&config)..."        │ │
│  │ └──────┘                                            │ │
│  │ ─────────────────────────────────────────────────── │ │
│  │ ┌──────┐ Yesterday, 4:45 PM · Firefox               │ │
│  │ │thumb │ PostgreSQL Docs - Connection Pooling...    │ │
│  │ └──────┘                                            │ │
│  │                    ... (scrollable)                  │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Screenshot Detail View (replaces results list on click)

```
┌─────────────────────────────────────────────────────────┐
│ ← Back to results                     [⏸ Capturing] [─] │insert
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Today, 2:34 PM · Firefox · "Stack Overflow - How to.." │
│                                                          │
│  ┌───────────────────────────────┬──────────────────┐   │
│  │                               │ Extracted Text    │   │
│  │                               │                   │   │
│  │     Full screenshot           │ The PostgreSQL    │   │insert
│  │     (zoomable/pannable)       │ connection pool   │   │
│  │                               │ was failing       │   │
│  │                               │ because the max   │   │
│  │                               │ connections was   │   │
│  │                               │ set to 5...       │   │
│  │                               │                   │   │
│  └───────────────────────────────┴──────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. App.tsx (Root)

- Manages view state: "search" | "detail"
- Provides TanStack QueryClient
- Handles global hotkey focus (receives event from Tauri)
- Shows header with daemon status indicator

### 2. SearchBar.tsx

**Props:** `onSearch(query, filters)`
**State:** query string, app filter, date range

- Text input with placeholder "Search your screen history..."
- Debounced search (300ms after last keystroke)
- Auto-focus on mount and on global hotkey trigger
- App filter dropdown (populated from unique app_names in DB via Tauri command)
- Date range: "Today", "Yesterday", "Last 7 days", "Last 30 days", "Custom"
- Enter key triggers immediate search
- Escape key clears search

**shadcn components:** Input, Select, Popover (date picker), Button

### 3. SearchResults.tsx

**Props:** `query, filters`
**State:** managed by TanStack Query

- Uses `useInfiniteQuery` for pagination (load more on scroll)
- Each result card shows:insert
  - Thumbnail (80x60px, lazy loaded via `loading="lazy"`)
  - Relative timestamp ("Today, 2:34 PM", "3 days ago")
  - App name with icon (optional, favicon or generic)
  - Window title (truncated to 1 line)
  - Matched text snippet with `<mark>` highlights (rendered as HTML)
- Click on result → navigate to detail view
- Empty state: "No results found" / "Start typing to search"
- Loading state: skeleton cards

**shadcn components:** Card, ScrollArea, Skeleton, Badge

### 4. ScreenshotDetail.tsx

**Props:** `screenshotId`
**State:** screenshot data via TanStack Query

- Full screenshot image (left panel, ~65% width)
  - Click to zoom / pan (simple CSS transform)
- OCR text panel (right panel, ~35% width)
  - Full extracted text, scrollable
  - Search query terms highlighted in text
  - Copy button for full text
- Metadata bar: timestamp, app name, window title
- Back button → return to search results (preserve scroll position)

**shadcn components:** Button, ScrollArea, Separator

### 5. DaemonStatus.tsx

**Props:** none (uses TanStack Query with 5s polling)

- Shows in header: "Capturing" (green dot) or "Paused" (yellow dot)
- Click → toggle pause/resume via Tauri command
- Tooltip: frames today, uptime
- "Daemon not running" state (red dot, grayed out)

**shadcn components:** Badge, Tooltip

## Tauri IPC (invoke wrappers)

```typescript
// src/lib/api.ts

import { invoke } from "@tauri-apps/api/core";

export interface SearchFilters {
  start_time?: number;  // Unix timestamp
  end_time?: number;
  app_name?: string;
  limit: number;
  offset: number;
}

export interface SearchResult {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  thumbnail_path: string;
  file_path: string;
  matched_text: string;  // HTML with <mark> tags
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total_count: number;
}

export interface ScreenshotDetail {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  window_class: string | null;
  file_path: string;
  width: number;
  height: number;
  ocr_text: string | null;
  bounding_boxes: BoundingBox[];
}

export interface DaemonStatus {
  is_capturing: boolean;
  frames_captured_today: number;
  frames_deduplicated_today: number;
  uptime_seconds: number;
  disk_usage_bytes: number;
}

export async function search(query: string, filters: SearchFilters): Promise<SearchResponse> {
  return invoke("search", { query, filters });
}

export async function getScreenshot(id: number): Promise<ScreenshotDetail> {
  return invoke("get_screenshot", { id });
}

export async function getScreenshotImageUrl(path: string): Promise<string> {
  return invoke("get_screenshot_image_url", { path });
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  return invoke("get_daemon_status");
}

export async function pauseCapture(): Promise<void> {
  return invoke("pause_capture");
}

export async function resumeCapture(): Promise<void> {
  return invoke("resume_capture");
}

export async function getAppNames(): Promise<string[]> {
  return invoke("get_app_names");
}
```

## TanStack Query Keys

```typescript
export const queryKeys = {
  search: (query: string, filters: SearchFilters) =>
    ["search", query, filters] as const,
  screenshot: (id: number) =>
    ["screenshot", id] as const,
  daemonStatus: () =>
    ["daemon-status"] as const,
  appNames: () =>
    ["app-names"] as const,
};
```

## Styling Notes

- Dark theme by default (developer tool aesthetic)
- shadcn "zinc" or "slate" color palette
- Monospace font for OCR text display (Jetbrains Mono or system monospace)
- System font stack for UI text
- Thumbnail border radius: 6px
- Highlight color for search matches: yellow/amber background
- Minimal animation (opacity transitions only, respect prefers-reduced-motion)
- Window size: 900x650 default, min 700x500

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Shift+Space | Global: open/focus app |
| / | Focus search input |
| Escape | Clear search / go back to results |
| Enter | Execute search immediately |
| ↑/↓ | Navigate results |
| Enter (on result) | Open detail view |
| Ctrl+C (in detail) | Copy OCR text |

## Image Serving

Screenshots are stored in `~/.rewindos/screenshots/`. Tauri needs to serve these files to the frontend.

**Approach:** Use Tauri's `asset:` protocol or `convertFileSrc()` to convert absolute file paths to URLs the webview can load.

```typescript
import { convertFileSrc } from "@tauri-apps/api/core";

// Convert ~/.rewindos/screenshots/2025-01-25/1706137200.webp
// to asset://localhost/home/user/.rewindos/screenshots/...
const imageUrl = convertFileSrc(absolutePath);
```

This requires the `asset` protocol scope in Tauri capabilities to include the `~/.rewindos/` directory.
