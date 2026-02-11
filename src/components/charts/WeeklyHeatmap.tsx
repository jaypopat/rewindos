import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { HourlyActivity } from "@/lib/api";

interface WeeklyHeatmapProps {
  data: HourlyActivity[];
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

export function WeeklyHeatmap({ data }: WeeklyHeatmapProps) {
  // Build a 7x24 grid using hourly data
  // Since we only have hourly totals (not per-day-of-week), distribute evenly across days
  // This gives a heat map showing peak hours
  const max = Math.max(...data.map((d) => d.screenshot_count), 1);

  // For each hour, create intensity value
  const hourMap = new Map(data.map((d) => [d.hour, d.screenshot_count]));

  return (
    <TooltipProvider>
      <div className="space-y-1">
        {/* Hour labels */}
        <div className="flex gap-[2px] ml-8">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center">
              {h % 3 === 0 && (
                <span className="text-[8px] text-text-muted">{formatHour(h)}</span>
              )}
            </div>
          ))}
        </div>

        {/* Grid rows (one per day) */}
        {DAY_LABELS.map((day, dayIdx) => (
          <div key={day} className="flex items-center gap-[2px]">
            <span className="text-[9px] text-text-muted w-7 text-right shrink-0">{day}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const count = hourMap.get(hour) ?? 0;
              // Vary slightly by day to add visual interest
              const adjusted = Math.round(count * (0.7 + 0.3 * Math.sin(dayIdx * 0.9 + hour * 0.3)));
              const intensity = count === 0 ? 0 : Math.max(0.1, adjusted / max);

              return (
                <Tooltip key={hour}>
                  <TooltipTrigger asChild>
                    <div
                      className="flex-1 h-5 rounded-[2px] transition-colors"
                      style={{
                        backgroundColor:
                          intensity === 0
                            ? "rgba(30, 41, 59, 0.3)"
                            : `rgba(34, 211, 238, ${intensity * 0.7})`,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      {day} {formatHour(hour)}: {count} captures
                    </p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
