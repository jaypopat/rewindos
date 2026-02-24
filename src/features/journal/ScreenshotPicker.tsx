import { useQuery } from "@tanstack/react-query";
import { browseScreenshots, getImageUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { X, ImageIcon } from "lucide-react";

interface ScreenshotPickerProps {
  dayStart: number;
  dayEnd: number;
  attachedIds: number[];
  onAttach: (id: number) => void;
  onClose: () => void;
}

export function ScreenshotPicker({
  dayStart,
  dayEnd,
  attachedIds,
  onAttach,
  onClose,
}: ScreenshotPickerProps) {
  const { data: screenshots = [], isLoading } = useQuery({
    queryKey: queryKeys.journalPicker(dayStart, dayEnd),
    queryFn: () => browseScreenshots(dayStart, dayEnd, undefined, 50),
  });

  const attachedSet = new Set(attachedIds);

  return (
    <div className="mt-2 p-3 bg-surface-raised border border-border/50 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-text-secondary font-medium">
          Pick from today's screenshots
        </span>
        <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors">
          <X className="size-3.5" strokeWidth={2} />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : screenshots.length === 0 ? (
        <p className="text-xs text-text-muted text-center py-4">
          No screenshots captured for this day.
        </p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {screenshots.map((ss) => {
            const isAttached = attachedSet.has(ss.id);
            return (
              <button
                key={ss.id}
                onClick={() => !isAttached && onAttach(ss.id)}
                disabled={isAttached}
                className={cn(
                  "shrink-0 w-24 h-16 rounded overflow-hidden border transition-all",
                  isAttached
                    ? "border-accent/50 opacity-50 cursor-not-allowed"
                    : "border-border/30 hover:border-accent/30 cursor-pointer",
                )}
              >
                {ss.thumbnail_path ? (
                  <img
                    src={getImageUrl(ss.thumbnail_path)}
                    alt=""
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full bg-surface-overlay flex items-center justify-center text-text-muted">
                    <ImageIcon className="size-4 opacity-30" strokeWidth={1} />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
