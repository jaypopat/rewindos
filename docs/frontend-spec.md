# RewindOS - Frontend Specification

## Overview

Multi-view desktop app built with React 19 + TypeScript + shadcn/ui + Tailwind CSS.
Runs inside Tauri v2 window. Communicates with Rust backend via `invoke()`.
Navigation via sidebar.

## Views

### Search View
Full-text + semantic search with grid/list toggle.

- **SearchBar**: Debounced text input (300ms), app filter dropdown, date range picker
- **SearchResults**: Container with grid/list toggle (ViewToggle)
- **SearchResultGrid**: Grid of thumbnails with "+N similar" dedup badges
- **SearchResultCard**: List view with inline thumbnails and dedup badges
- **SemanticBadge**: Shows "ai search" (hybrid mode) or "keyword" (FTS5-only mode)
- **ScreenshotDetail**: Full screenshot + OCR text panel with bounding box overlay

### History View
Chronological screenshot browser with two viewing modes.

- **TimelineMode**: Browse screenshots by date/time with hourly grouping (HourGroup)
- **AppsMode**: Filter by application
- Date range selection (RangeSelectToolbar) with presets
- DailyDigestCard for AI-generated summaries
- Custom hooks: `useHistoryData`, `useRangeSelection`

### Rewind View
Timelapse playback of screen history.

- **RewindPlayer**: Canvas-based renderer for smooth playback
- **RewindControls**: Play/pause, speed (0.5x–8x)
- **RewindScrubber**: Timeline slider for seeking
- Keyboard navigation (arrow keys, space, speed shortcuts)
- Custom hooks: `usePlayback`, `useRewindData`, `useScrubber`, `useRewindKeyboard`

### Dashboard View
Analytics dashboard with charts and stats.

- App usage breakdown with categories (CategoriesBreakdown)
- Daily/hourly activity charts (DailyActivityChart, HourlyActivityChart)
- Screen time chart and heatmap calendar
- CapturesCarousel for recent screenshots
- TopTasksList for most-used apps
- AppTimeline for top-app timeline view
- StatCard and Sparkline components

### Ask View
AI chat interface powered by Ollama.

- Intent detection (recall, time-based, productivity, app-specific, general)
- Streaming chat responses with markdown rendering
- Screenshot references with clickable cards (ScreenshotRefCard)
- Session management (new session, cancel)
- AskEmptyState for onboarding
- Managed via AskContext (React context + TanStack Query)

### Journal View
Daily journaling with rich text editing.

- **JournalEditor**: Tiptap rich text editor with formatting toolbar
- **JournalSidebar**: Date picker, navigation, MiniCalendarHeatmap
- **TagEditor**: Tag management with colors
- **SlashMenu**: Command menu (`/template`, `/image`)
- **ScreenshotPicker**: Modal to attach screenshots from history
- **AttachedScreenshot**: Inline screenshot display with captions
- **JournalSearchPanel**: FTS5 search across journal entries
- **AISummaryPanel**: Generate daily/weekly AI summaries
- **OpenTodosPanel**: Parse and display TODO items from entries
- **ExportDialog**: Export journal to Markdown or HTML
- Template system with 4 built-in templates (Daily Reflection, Standup, Gratitude, Weekly Review)

### Saved View
Bookmarks and collections browser.

- **SavedView**: Browse all collections, view bookmarked screenshots
- **CollectionDetailView**: View and manage screenshots in a collection
- BookmarkButton and AddToCollectionMenu on screenshot cards

### Focus View
Pomodoro timer with productivity tracking.

- Configurable work/break durations
- Distraction app detection
- Daily goal progress
- Session history

### Settings View
Full configuration UI organized into tabs.

- **GeneralTab**: Capture interval, sensitivity, retention
- **CaptureTab**: Capture backend, window detection
- **OCRTab**: Language, worker count
- **PrivacyTab**: Excluded apps, window title patterns
- **StorageTab**: Disk limits, cleanup
- **AITab**: Ollama endpoint, semantic search, chat model config
- **FocusTab**: Pomodoro timer settings, distraction apps
- Reusable form primitives: TextField, NumberInput, Toggle, ListInput, CategoryRulesEditor

## Key Components

### SearchResultGrid.tsx
Grid view showing screenshot thumbnails in a responsive grid.

- Thumbnail with aspect-video ratio
- "+N similar" badge (top-right) when `group_count > 1` — indicates scene dedup grouping
- Metadata overlay: app name (with AppDot color), relative timestamp
- Hover: shows matched OCR text snippet with `<mark>` highlights

### SearchResultCard.tsx
List view showing results as horizontal cards.

- Inline thumbnail (112×72px)
- "+N" badge on thumbnail when grouped
- Relative timestamp, app name, window title
- Matched text snippet with highlights

### SemanticBadge.tsx
Shows the active search mode.

- **"ai search"** (purple/semantic color): hybrid mode — FTS5 + vector + RRF
- **"keyword"** (muted): FTS5-only mode — no Ollama available
- Hidden when no search active

### ScreenshotDetail.tsx
Full screenshot viewer with OCR text panel.

- Full-size screenshot (zoomable)
- BoundingBoxOverlay for word-level regions
- OCR text panel (right side)
- Copy text button
- Metadata: timestamp, app, window title

## Tauri IPC (api.ts)

```typescript
interface SearchResult {
  id: number;
  timestamp: number;
  app_name: string | null;
  window_title: string | null;
  thumbnail_path: string | null;
  file_path: string;
  matched_text: string;
  rank: number;
  group_count?: number;          // Scene dedup: number of similar screenshots
  group_screenshot_ids?: number[]; // Scene dedup: IDs of grouped screenshots
}

interface SearchResponse {
  results: SearchResult[];
  total_count: number;
  search_mode?: string;  // "keyword" | "hybrid"
}
```

**Key functions:**
- `search(query, filters)` — Full-text/hybrid search
- `getScreenshot(id)` — Full screenshot detail with OCR text
- `getDaemonStatus()` — Capture status, metrics
- `pauseCapture()` / `resumeCapture()` — Control daemon
- `getAppNames()` — Distinct app names for filter dropdown
- `browseScreenshots(startTime, endTime, appName, limit)` — Timeline browsing
- `getActivity(sinceTimestamp)` — App usage, daily/hourly activity
- `getTaskBreakdown(startTime, endTime)` — Per-app time estimates
- `getActiveBlocks(startTime, endTime)` — Active time blocks
- `getDailySummary(startTime, endTime)` — AI-generated daily summary
- `ask(sessionId, message)` — AI chat
- `askHealth()` / `askNewSession()` / `askCancel(sessionId)` — Chat session management
- `deleteScreenshotsInRange(startTime, endTime)` — Privacy delete
- `getConfig()` / `updateConfig(config)` — Settings management
- `toggleBookmark(id)` / `isBookmarked(id)` / `getBookmarkedIds()` / `listBookmarks()` — Bookmarking
- `createCollection()` / `updateCollection()` / `deleteCollection()` / `listCollections()` — Collections
- `getCollectionScreenshots()` / `addToCollection()` / `removeFromCollection()` — Collection items
- `upsertJournalEntry()` / `deleteJournalEntry()` / `getJournalEntry()` / `getJournalDates()` — Journal CRUD
- `getJournalStreak()` / `getOpenTodos()` / `searchJournal(query)` — Journal queries
- `addJournalScreenshot()` / `removeJournalScreenshot()` / `getJournalScreenshots()` — Journal screenshots
- `setJournalTags()` / `getJournalTags()` / `listAllJournalTags()` — Tag system
- `listJournalTemplates()` / `createJournalTemplate()` / `deleteJournalTemplate()` — Templates
- `generateJournalSummary(periodType, periodKey)` — AI summaries
- `exportJournal(format)` — Export to Markdown/HTML

## Image Serving

Screenshots served via Tauri's `convertFileSrc()` which maps absolute file paths
to `asset://` protocol URLs the webview can load.

```typescript
import { convertFileSrc } from "@tauri-apps/api/core";
const imageUrl = convertFileSrc(absolutePath);
```

## Styling

- Dark theme by default (developer tool aesthetic)
- Custom CSS variables for theming (surface, accent, semantic colors)
- Monospace font for OCR text and code
- System font for UI text
- Minimal animations (fade-in-up, respect prefers-reduced-motion)
- Responsive grid layouts

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Shift+Space | Global: open/focus app |
| / | Focus search input |
| Escape | Clear search / go back |
| Enter | Execute search |
