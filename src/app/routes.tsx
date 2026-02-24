import { lazy, Suspense, type ReactNode } from "react";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";

// Dashboard stays eagerly loaded (default view)
export { DashboardView } from "@/features/dashboard/DashboardView";

// Lazy-loaded views
export const HistoryView = lazy(() =>
  import("@/features/history/HistoryView").then((m) => ({
    default: m.HistoryView,
  })),
);

export const RewindView = lazy(() =>
  import("@/features/rewind/RewindView").then((m) => ({
    default: m.RewindView,
  })),
);

export const AskView = lazy(() =>
  import("@/features/ask/AskView").then((m) => ({
    default: m.AskView,
  })),
);

export const SavedView = lazy(() =>
  import("@/features/saved/SavedView").then((m) => ({
    default: m.SavedView,
  })),
);

export const JournalView = lazy(() =>
  import("@/features/journal/JournalView").then((m) => ({
    default: m.JournalView,
  })),
);

export const FocusView = lazy(() =>
  import("@/features/focus/FocusView").then((m) => ({
    default: m.FocusView,
  })),
);

export const SettingsView = lazy(() =>
  import("@/features/settings/SettingsView").then((m) => ({
    default: m.SettingsView,
  })),
);

export const ScreenshotDetail = lazy(() =>
  import("@/components/ScreenshotDetail").then((m) => ({
    default: m.ScreenshotDetail,
  })),
);

export function ViewSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center">
          <LoadingSpinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
