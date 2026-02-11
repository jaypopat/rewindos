import { getImageUrl } from "@/lib/api";
import type { ScreenshotRef } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";

interface ScreenshotRefCardProps {
  reference: ScreenshotRef;
  onClick: () => void;
}

export function ScreenshotRefCard({ reference, onClick }: ScreenshotRefCardProps) {
  return (
    <button
      onClick={onClick}
      className="group inline-flex items-center gap-2 px-2 py-1.5 border border-border/60 hover:border-accent/40 bg-surface-raised/50 hover:bg-accent/5 transition-all my-1"
    >
      {/* Tiny thumbnail */}
      <div className="w-10 h-7 bg-surface-overlay overflow-hidden shrink-0">
        <img
          src={getImageUrl(reference.file_path)}
          alt=""
          className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity"
        />
      </div>

      {/* Meta */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-[10px] text-accent/70 group-hover:text-accent shrink-0">
          #{reference.id}
        </span>
        {reference.app_name && (
          <span className="text-[11px] text-text-secondary truncate max-w-24">
            {reference.app_name}
          </span>
        )}
        <span className="font-mono text-[10px] text-text-muted shrink-0">
          {formatRelativeTime(reference.timestamp)}
        </span>
      </div>

      {/* Arrow indicator */}
      <svg className="size-3 text-text-muted group-hover:text-accent shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" />
      </svg>
    </button>
  );
}
