import { formatSecs } from "@/lib/format";
import { formatHour, type AppSpan } from "./dashboard-utils";
import { getAppColor } from "@/lib/app-colors";

interface AppTimelineProps {
  spans: AppSpan[];
  todayStart: number;
}

export function AppTimeline({ spans, todayStart }: AppTimelineProps) {
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
        <div className="relative h-6 bg-surface-raised rounded overflow-hidden">
          {spans.map((span) => {
            const blockStart = Math.max(span.startTime, rangeStart);
            const blockEnd = Math.min(span.endTime, rangeEnd);
            if (blockEnd <= rangeStart || blockStart >= rangeEnd) return null;
            const left = ((blockStart - rangeStart) / (rangeEnd - rangeStart)) * 100;
            const width = ((blockEnd - blockStart) / (rangeEnd - rangeStart)) * 100;
            return (
              <div
                key={`${span.startTime}-${span.appName}`}
                className="absolute top-0 h-full rounded-sm"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.3)}%`,
                  backgroundColor: getAppColor(span.appName),
                  opacity: 0.8,
                }}
                title={`${span.appName}: ${new Date(blockStart * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${new Date(blockEnd * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${formatSecs(blockEnd - blockStart)})`}
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
      </div>
    </div>
  );
}
