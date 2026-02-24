import { Play, Pause, Scissors, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPEEDS } from "@/features/rewind/rewind-utils";

interface RewindControlsProps {
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  playbackSpeed: (typeof SPEEDS)[number];
  setPlaybackSpeed: (speed: (typeof SPEEDS)[number]) => void;
  rangeMode: boolean;
  currentIndex: number;
  onToggleRangeMode: () => void;
  rangeSelFractions: { left: number; right: number; count: number } | null;
  onDeleteClick: () => void;
  screenshotCount: number;
}

export function RewindControls({
  isPlaying,
  setIsPlaying,
  playbackSpeed,
  setPlaybackSpeed,
  rangeMode,
  currentIndex,
  onToggleRangeMode,
  rangeSelFractions,
  onDeleteClick,
  screenshotCount,
}: RewindControlsProps) {
  return (
    <div className="shrink-0 border-t border-border/30 px-5 py-2 flex items-center gap-3">
      {/* Play/Pause */}
      <button
        onClick={() => setIsPlaying((p) => !p)}
        className="p-1.5 rounded-md hover:bg-surface-raised transition-colors text-text-secondary hover:text-text-primary"
        title={isPlaying ? "Pause (Space)" : "Play (Space)"}
      >
        {isPlaying ? (
          <Pause className="size-4" strokeWidth={2} />
        ) : (
          <Play className="size-4" strokeWidth={2} />
        )}
      </button>

      {/* Speed toggles */}
      <div className="flex gap-0.5 bg-surface-raised/60 rounded-md p-0.5">
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setPlaybackSpeed(s)}
            className={cn(
              "px-2 py-0.5 text-[11px] rounded transition-colors font-mono",
              playbackSpeed === s
                ? "bg-accent/15 text-accent font-medium"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="w-px h-4 bg-border/30" />

      {/* Range select toggle */}
      <button
        onClick={onToggleRangeMode}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors",
          rangeMode
            ? "bg-red-500/15 text-red-400"
            : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
        )}
        title="Select range for bulk delete"
      >
        <Scissors className="size-3.5" strokeWidth={1.8} />
        {rangeMode ? "Cancel" : "Select Range"}
      </button>

      {/* Range action */}
      {rangeSelFractions && rangeSelFractions.count >= 1 && (
        <>
          <span className="text-xs text-text-muted">
            {rangeSelFractions.count} selected
          </span>
          <button
            onClick={onDeleteClick}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
          >
            <Trash2 className="size-3.5" strokeWidth={1.8} />
            Delete
          </button>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Keyboard hints */}
      <div className="hidden md:flex items-center gap-3 text-[10px] text-text-muted">
        {rangeMode ? (
          <>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                &larr; &rarr;
              </kbd>{" "}
              extend
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                Del
              </kbd>{" "}
              delete
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                Esc
              </kbd>{" "}
              cancel
            </span>
          </>
        ) : (
          <>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                &larr; &rarr;
              </kbd>{" "}
              step
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                Space
              </kbd>{" "}
              play
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-surface-raised text-[10px]">
                &crarr;
              </kbd>{" "}
              detail
            </span>
          </>
        )}
      </div>

      {/* Counter */}
      <span className="text-xs text-text-muted font-mono tabular-nums">
        {currentIndex + 1} / {screenshotCount}
      </span>
    </div>
  );
}
