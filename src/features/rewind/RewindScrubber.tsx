import type { ActivitySegment } from "@/features/rewind/rewind-utils";

interface RewindScrubberProps {
  segments: ActivitySegment[];
  timeLabels: { fraction: number; label: string }[];
  handleFraction: number;
  rangeSelFractions: { left: number; right: number; count: number } | null;
  timeToFraction: (t: number) => number;
  trackRef: React.RefObject<HTMLDivElement | null>;
  handleRef: React.RefObject<HTMLDivElement | null>;
  hoverPreviewRef: React.RefObject<HTMLDivElement | null>;
  hoverImgRef: React.RefObject<HTMLImageElement | null>;
  hoverTimeRef: React.RefObject<HTMLSpanElement | null>;
  onTrackMouseDown: (e: React.MouseEvent) => void;
  onTrackMouseMove: (e: React.MouseEvent) => void;
  onTrackMouseLeave: () => void;
}

export function RewindScrubber({
  segments,
  timeLabels,
  handleFraction,
  rangeSelFractions,
  timeToFraction,
  trackRef,
  handleRef,
  hoverPreviewRef,
  hoverImgRef,
  hoverTimeRef,
  onTrackMouseDown,
  onTrackMouseMove,
  onTrackMouseLeave,
}: RewindScrubberProps) {
  return (
    <div className="shrink-0 border-t border-border/30 px-5 pt-2 pb-1">
      {/* Time labels */}
      <div className="relative h-4 mb-1">
        {timeLabels.map((tl) => (
          <span
            key={tl.fraction}
            className="absolute text-[10px] text-text-muted font-mono -translate-x-1/2"
            style={{ left: `${tl.fraction * 100}%` }}
          >
            {tl.label}
          </span>
        ))}
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        role="group"
        aria-label="Timeline track"
        className="relative h-8 rounded-md bg-surface-raised/60 cursor-pointer select-none overflow-hidden"
        onMouseDown={onTrackMouseDown}
        onMouseMove={onTrackMouseMove}
        onMouseLeave={onTrackMouseLeave}
      >
        {/* Activity segments */}
        {segments.map((seg) => {
          const left = timeToFraction(seg.startTime) * 100;
          const right = timeToFraction(seg.endTime + 5) * 100;
          const width = Math.max(right - left, 0.3);
          return (
            <div
              key={`${seg.startTime}-${seg.color}`}
              className="absolute top-1 bottom-1 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: seg.color,
                opacity: 0.7,
              }}
              title={`${seg.appName} (${seg.endIdx - seg.startIdx + 1} captures)`}
            />
          );
        })}

        {/* Range selection overlay */}
        {rangeSelFractions && (
          <div
            className="absolute top-0 bottom-0 bg-red-500/20 border-x-2 border-red-500/50 pointer-events-none"
            style={{
              left: `${rangeSelFractions.left * 100}%`,
              width: `${(rangeSelFractions.right - rangeSelFractions.left) * 100}%`,
            }}
          />
        )}

        {/* Hover preview tooltip */}
        <div
          ref={hoverPreviewRef}
          className="absolute bottom-full mb-2 -translate-x-1/2 pointer-events-none z-20 hidden"
          style={{ left: "50%" }}
        >
          <div className="bg-surface-raised border border-border/50 rounded-lg shadow-xl overflow-hidden">
            <img
              ref={hoverImgRef}
              alt=""
              className="w-40 h-24 object-cover"
            />
            <div className="px-2 py-1 text-center">
              <span
                ref={hoverTimeRef}
                className="text-[10px] text-text-muted font-mono"
              />
            </div>
          </div>
        </div>

        {/* Scrub handle */}
        <div
          ref={handleRef}
          className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none z-10 transition-[left] duration-75"
          style={{ left: `${handleFraction * 100}%` }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-background shadow" />
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-accent border-2 border-background shadow" />
        </div>
      </div>
    </div>
  );
}
