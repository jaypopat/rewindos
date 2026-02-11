import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface HeatmapDay {
  date: string;
  count: number;
  uniqueApps?: number;
}

interface HeatmapCalendarProps {
  data: HeatmapDay[];
  weeks?: number;
}

const LEVELS = [
  "bg-surface-overlay/30",
  "bg-accent/15",
  "bg-accent/30",
  "bg-accent/50",
  "bg-accent/75",
];

function getLevel(count: number, max: number): number {
  if (count === 0) return 0;
  if (max === 0) return 0;
  const ratio = count / max;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

export function HeatmapCalendar({ data, weeks = 16 }: HeatmapCalendarProps) {
  const dateMap = new Map(data.map((d) => [d.date, d]));
  const max = Math.max(...data.map((d) => d.count), 1);

  // Build grid: weeks x 7 days
  const today = new Date();
  const cells: { date: string; day: HeatmapDay | undefined }[] = [];

  // Go back `weeks` weeks from today
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (weeks * 7 - 1) - startDate.getDay());

  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const isFuture = d > today;
    cells.push({
      date: dateStr,
      day: isFuture ? undefined : dateMap.get(dateStr),
    });
  }

  // Group into columns (weeks)
  const columns: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    columns.push(cells.slice(i, i + 7));
  }

  const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];

  return (
    <TooltipProvider>
      <div className="flex gap-1">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] mr-1">
          {dayLabels.map((label, i) => (
            <span key={i} className="text-[9px] text-text-muted leading-[12px] h-3 flex items-center">
              {label}
            </span>
          ))}
        </div>

        {/* Heatmap grid */}
        {columns.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((cell) => {
              const count = cell.day?.count ?? 0;
              const level = cell.day === undefined ? -1 : getLevel(count, max);
              const apps = cell.day?.uniqueApps;

              return (
                <Tooltip key={cell.date}>
                  <TooltipTrigger asChild>
                    <div
                      className={`w-3 h-3 rounded-[2px] transition-colors ${
                        level === -1 ? "bg-transparent" : LEVELS[level]
                      }`}
                    />
                  </TooltipTrigger>
                  {level >= 0 && (
                    <TooltipContent>
                      <div className="text-xs">
                        <p className="font-medium">{cell.date}</p>
                        <p>{count} capture{count !== 1 ? "s" : ""}</p>
                        {apps != null && <p>{apps} app{apps !== 1 ? "s" : ""}</p>}
                      </div>
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
