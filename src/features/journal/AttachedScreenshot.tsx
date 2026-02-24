import { useQuery } from "@tanstack/react-query";
import { getImageUrl, type JournalScreenshot } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { X, ImageIcon } from "lucide-react";

interface AttachedScreenshotProps {
  journalScreenshot: JournalScreenshot;
  onRemove: () => void;
  onClick: () => void;
}

export function AttachedScreenshot({
  journalScreenshot,
  onRemove,
  onClick,
}: AttachedScreenshotProps) {
  const { data: screenshotData } = useQuery({
    queryKey: queryKeys.screenshot(journalScreenshot.screenshot_id),
    queryFn: async () => {
      const { getScreenshot } = await import("@/lib/api");
      return getScreenshot(journalScreenshot.screenshot_id);
    },
  });

  return (
    <div className="relative group shrink-0">
      <button
        onClick={onClick}
        className="w-24 h-16 bg-surface-overlay border border-border/30 rounded overflow-hidden hover:border-accent/30 transition-colors"
      >
        {screenshotData?.file_path ? (
          <img
            src={getImageUrl(screenshotData.file_path)}
            alt={journalScreenshot.caption ?? ""}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-text-muted">
            <ImageIcon className="size-4 opacity-30" strokeWidth={1} />
          </div>
        )}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-surface border border-border/50 rounded-full flex items-center justify-center text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
      >
        <X className="size-2.5" strokeWidth={2} />
      </button>
      {journalScreenshot.caption && (
        <p className="text-[9px] text-text-muted truncate w-24 mt-0.5">
          {journalScreenshot.caption}
        </p>
      )}
    </div>
  );
}
