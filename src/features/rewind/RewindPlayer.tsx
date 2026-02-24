import { getImageUrl, type TimelineEntry } from "@/lib/api";
import { getAppColor } from "@/lib/app-colors";
import { Maximize2 } from "lucide-react";
import { formatTimeShort } from "@/features/rewind/rewind-utils";

interface RewindPlayerProps {
  currentScreenshot: TimelineEntry | null;
  allIds: number[];
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

export function RewindPlayer({
  currentScreenshot,
  allIds,
  onSelectScreenshot,
}: RewindPlayerProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-0 px-5 py-3 gap-2">
      {/* Screenshot */}
      <div className="relative flex-1 w-full flex items-center justify-center min-h-0">
        {currentScreenshot && (
          <img
            src={getImageUrl(currentScreenshot.file_path)}
            alt=""
            className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            draggable={false}
          />
        )}
        {/* Expand button */}
        {currentScreenshot && (
          <button
            onClick={() => onSelectScreenshot(currentScreenshot.id, allIds)}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-black/50 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            title="View full detail (Enter)"
          >
            <Maximize2 className="size-4" strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Info bar under screenshot */}
      {currentScreenshot && (
        <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-surface-raised/60 border border-border/20">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{
              backgroundColor: getAppColor(currentScreenshot.app_name),
            }}
          />
          <span className="text-sm text-text-primary truncate max-w-md">
            {currentScreenshot.app_name ?? "Unknown"}
            {currentScreenshot.window_title && (
              <span className="text-text-muted">
                {" "}
                &middot; {currentScreenshot.window_title}
              </span>
            )}
          </span>
          <span className="text-xs text-text-muted font-mono tabular-nums ml-auto shrink-0">
            {formatTimeShort(currentScreenshot.timestamp)}
          </span>
        </div>
      )}
    </div>
  );
}
