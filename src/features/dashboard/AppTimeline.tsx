import { useCallback, useMemo, useRef, useState } from "react";
import { formatHour, type AppSpan } from "./dashboard-utils";
import { getAppColor } from "@/lib/app-colors";
import { getImageUrl, type TimelineEntry } from "@/lib/api";

interface HoverState {
  screenshot: TimelineEntry;
  mouseX: number;
  span: AppSpan | null;
}

interface AppTimelineProps {
  spans: AppSpan[];
  todayStart: number;
  screenshots: TimelineEntry[];
  onSelectScreenshot?: (id: number, siblingIds?: number[]) => void;
}

export function AppTimeline({ spans, todayStart, screenshots, onSelectScreenshot }: AppTimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  // Compute range from actual data: earliest span to now (or latest span + pad)
  const now = Math.floor(Date.now() / 1000);
  const earliest = spans.reduce((min, s) => Math.min(min, s.startTime), spans[0].startTime);
  const latest = spans.reduce((max, s) => Math.max(max, s.endTime), spans[0].endTime);

  // Round down to even hour for start, round up for end
  const earliestHour = Math.floor((earliest - todayStart) / 3600);
  const latestHour = Math.ceil((Math.max(latest, now) - todayStart) / 3600) + 1;

  const startHour = Math.max(0, earliestHour - (earliestHour % 2)); // align to even
  const endHour = Math.min(24, latestHour + (latestHour % 2)); // align to even
  const totalHours = Math.max(endHour - startHour, 2);

  const rangeStart = todayStart + startHour * 3600;
  const rangeEnd = todayStart + endHour * 3600;

  const hourLabels = [];
  const step = totalHours <= 8 ? 1 : 2;
  for (let h = startHour; h <= endHour; h += step) {
    hourLabels.push(h);
  }

  // Screenshots sorted by timestamp for binary search
  const sortedScreenshots = useMemo(
    () => [...screenshots].sort((a, b) => a.timestamp - b.timestamp),
    [screenshots],
  );

  // Find the screenshot closest to a given timestamp via binary search
  const findClosest = useCallback(
    (ts: number): TimelineEntry | null => {
      const arr = sortedScreenshots;
      if (arr.length === 0) return null;

      let lo = 0;
      let hi = arr.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].timestamp < ts) lo = mid + 1;
        else hi = mid;
      }
      // Check lo and lo-1 for the closest
      let best = lo;
      if (lo > 0 && Math.abs(arr[lo - 1].timestamp - ts) < Math.abs(arr[lo].timestamp - ts)) {
        best = lo - 1;
      }
      // Only show if within 60 seconds
      if (Math.abs(arr[best].timestamp - ts) > 60) return null;
      return arr[best];
    },
    [sortedScreenshots],
  );

  // Find which span contains a given timestamp
  const findSpan = useCallback(
    (ts: number): AppSpan | null => {
      for (const span of spans) {
        if (ts >= span.startTime && ts <= span.endTime) return span;
      }
      return null;
    },
    [spans],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const bar = barRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, relX / rect.width));
      const ts = rangeStart + ratio * (rangeEnd - rangeStart);
      const closest = findClosest(ts);
      if (closest) {
        setHover({ screenshot: closest, mouseX: relX, span: findSpan(ts) });
      } else {
        setHover(null);
      }
    },
    [rangeStart, rangeEnd, findClosest, findSpan],
  );

  const handleMouseLeave = useCallback(() => setHover(null), []);

  // Clamp tooltip position within the bar
  const tooltipWidth = 260;
  const getTooltipLeft = (mouseX: number, containerWidth: number) => {
    const half = tooltipWidth / 2;
    let left = mouseX - half;
    if (left < 0) left = 0;
    if (left + tooltipWidth > containerWidth) left = containerWidth - tooltipWidth;
    return left;
  };

  return (
    <div className="border border-border/50 px-4 py-3">
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
        Today's Timeline
      </h3>
      <div className="relative">
        <div className="flex justify-between mb-1">
          {hourLabels.map((h) => (
            <span
              key={h}
              className="text-[10px] text-text-muted font-mono"
              style={{ width: `${(step / totalHours) * 100}%` }}
            >
              {formatHour(h % 24)}
            </span>
          ))}
        </div>
        <div
          ref={barRef}
          className="relative h-6 bg-surface-raised rounded overflow-hidden cursor-pointer"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={() => {
            if (hover && onSelectScreenshot) {
              onSelectScreenshot(hover.screenshot.id, sortedScreenshots.map(s => s.id));
            }
          }}
        >
          {spans.map((span) => {
            const blockStart = Math.max(span.startTime, rangeStart);
            const blockEnd = Math.min(span.endTime, rangeEnd);
            if (blockEnd <= rangeStart || blockStart >= rangeEnd) return null;
            const left = ((blockStart - rangeStart) / (rangeEnd - rangeStart)) * 100;
            const width = ((blockEnd - blockStart) / (rangeEnd - rangeStart)) * 100;
            return (
              <div
                key={`${span.startTime}-${span.appName}`}
                className="absolute top-0 h-full rounded-sm opacity-80 hover:opacity-100 transition-opacity"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.3)}%`,
                  backgroundColor: getAppColor(span.appName),
                }}
              />
            );
          })}
          {/* Current time marker */}
          {now >= rangeStart && now <= rangeEnd && (
            <div
              className="absolute top-0 h-full w-px bg-red-400/60"
              style={{ left: `${((now - rangeStart) / (rangeEnd - rangeStart)) * 100}%` }}
            />
          )}
        </div>

        {/* Hover preview tooltip */}
        {hover && barRef.current && (
          <div
            className="absolute bottom-full mb-2 z-50 pointer-events-none"
            style={{
              left: getTooltipLeft(hover.mouseX, barRef.current.getBoundingClientRect().width),
              width: tooltipWidth,
            }}
          >
            <div className="bg-surface-overlay border border-border rounded-lg shadow-xl overflow-hidden">
              <img
                src={getImageUrl(hover.screenshot.thumbnail_path ?? hover.screenshot.file_path)}
                alt=""
                className="w-full h-auto object-cover"
                draggable={false}
              />
              <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-text-secondary font-medium truncate">
                  {hover.span?.appName ?? hover.screenshot.app_name ?? "Unknown"}
                </span>
                <span className="text-[10px] text-text-muted font-mono whitespace-nowrap">
                  {new Date(hover.screenshot.timestamp * 1000).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
