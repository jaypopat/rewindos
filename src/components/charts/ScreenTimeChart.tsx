import { useState } from "react";
import type { ActiveBlock } from "@/lib/api";

const BAR_AREA_HEIGHT = 140;

interface Props {
  blocks: ActiveBlock[];
  selectedStart: number;
  selectedEnd: number;
}

interface DayData {
  date: string;
  dayLabel: string;
  dateLabel: string;
  minutes: number;
  highlighted: boolean;
  isToday: boolean;
}

function toDateStr(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function groupBlocksByDay(
  blocks: ActiveBlock[],
  selectedStart: number,
  selectedEnd: number,
): DayData[] {
  const map = new Map<string, number>();

  for (const block of blocks) {
    const d = new Date(block.start_time * 1000);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    map.set(dateStr, (map.get(dateStr) ?? 0) + block.duration_secs);
  }

  const selStartDate = toDateStr(selectedStart);
  const selEndDate = toDateStr(selectedEnd - 1);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = toDateStr(Math.floor(today.getTime() / 1000));
  const yesterdayStr = toDateStr(Math.floor(today.getTime() / 1000) - 86400);

  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const days = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, secs]) => {
      const d = new Date(date + "T00:00:00");
      let dayLabel: string;
      if (date === todayStr) dayLabel = "Today";
      else if (date === yesterdayStr) dayLabel = "Yest";
      else dayLabel = DAYS[d.getDay()];

      // Only highlight for single-day ranges (1 day = 86400s)
      const isSingleDay = (selectedEnd - selectedStart) <= 86400;

      return {
        date,
        dayLabel,
        dateLabel: `${d.getDate()}/${d.getMonth() + 1}`,
        minutes: Math.round(secs / 60),
        highlighted: isSingleDay && date >= selStartDate && date <= selEndDate,
        isToday: date === todayStr,
      };
    });

  return days;
}

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function fmtMinsFull(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function ScreenTimeChart({ blocks, selectedStart, selectedEnd }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (blocks.length === 0) {
    return (
      <p className="text-text-muted text-sm text-center py-8">
        No screen time data available
      </p>
    );
  }

  const data = groupBlocksByDay(blocks, selectedStart, selectedEnd);
  if (data.length === 0) {
    return (
      <p className="text-text-muted text-sm text-center py-8">
        No screen time data available
      </p>
    );
  }

  const maxMinutes = Math.max(...data.map((d) => d.minutes), 1);
  const avg = Math.round(data.reduce((s, d) => s + d.minutes, 0) / data.length);
  const avgBarH = Math.round((avg / maxMinutes) * BAR_AREA_HEIGHT);

  const hasHighlight = data.some((d) => d.highlighted);
  const hasToday = data.some((d) => d.isToday);

  // Insights for highlighted days (single-day view)
  const highlightedDays = data.filter((d) => d.highlighted);
  const highlightedAvg =
    highlightedDays.length > 0
      ? Math.round(highlightedDays.reduce((s, d) => s + d.minutes, 0) / highlightedDays.length)
      : 0;
  const diff = highlightedAvg - avg;
  const diffPct = avg > 0 ? Math.round((Math.abs(diff) / avg) * 100) : 0;

  // Best and worst
  const sorted = [...data].sort((a, b) => b.minutes - a.minutes);
  const best = sorted[0];
  const least = sorted[sorted.length - 1];

  return (
    <div className="flex flex-col gap-2.5">
      {/* Chart area */}
      <div className="relative" style={{ height: BAR_AREA_HEIGHT + 16 }}>
        {/* Average line */}
        {avg > 0 && (
          <div
            className="absolute left-0 right-0 z-10 pointer-events-none flex items-center"
            style={{ bottom: avgBarH + 16 }}
          >
            <div className="flex-1 border-t border-dashed border-slate-500/40" />
            <span className="text-[9px] text-text-muted font-mono ml-1.5 shrink-0">
              avg {fmtMins(avg)}
            </span>
          </div>
        )}

        {/* Bars row */}
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-1.5 px-0.5" style={{ height: BAR_AREA_HEIGHT }}>
          {data.map((day) => {
            const barH = Math.max(Math.round((day.minutes / maxMinutes) * BAR_AREA_HEIGHT), 3);
            const isHovered = hovered === day.date;
            const isAccented = day.highlighted || (!hasHighlight && day.isToday);
            const isDimmed = (hasHighlight || hasToday) && !isAccented && !isHovered;

            let barClass: string;
            if (day.highlighted) {
              barClass = "bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.35)]";
            } else if (day.isToday && !hasHighlight) {
              barClass = "bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.35)]";
            } else if (isHovered) {
              barClass = "bg-violet-400/80 shadow-[0_0_10px_rgba(167,139,250,0.3)]";
            } else if (isDimmed) {
              barClass = "bg-slate-600/30";
            } else {
              barClass = "bg-cyan-400/60";
            }

            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col items-center justify-end cursor-default"
                style={{ height: BAR_AREA_HEIGHT }}
                onMouseEnter={() => setHovered(day.date)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* Value on top of bar */}
                <span
                  className={`text-[9px] font-mono tabular-nums mb-1 transition-colors ${
                    isAccented
                      ? "text-cyan-300 font-medium"
                      : isHovered
                        ? "text-violet-300 font-medium"
                        : isDimmed
                          ? "text-text-muted/40"
                          : "text-text-secondary"
                  }`}
                >
                  {fmtMins(day.minutes)}
                </span>
                {/* Bar */}
                <div
                  className={`w-full max-w-[36px] rounded-t transition-all ${barClass}`}
                  style={{ height: barH }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* X-axis labels — day + date, always visible */}
      <div className="flex gap-1.5 px-0.5">
        {data.map((day) => {
          const isHovered = hovered === day.date;
          const isAccented = day.highlighted || (!hasHighlight && day.isToday);
          const isDimmed = (hasHighlight || hasToday) && !isAccented && !isHovered;
          return (
            <div key={day.date} className="flex-1 flex flex-col items-center">
              <span
                className={`text-[10px] leading-tight font-medium transition-colors ${
                  isAccented
                    ? "text-cyan-300"
                    : isHovered
                      ? "text-violet-300"
                      : isDimmed
                        ? "text-text-muted/60"
                        : "text-text-secondary"
                }`}
              >
                {day.dayLabel}
              </span>
              <span
                className={`text-[9px] leading-tight font-mono transition-colors ${
                  isAccented
                    ? "text-cyan-300/70"
                    : isHovered
                      ? "text-violet-300/70"
                      : "text-text-muted/40"
                }`}
              >
                {day.dateLabel}
              </span>
            </div>
          );
        })}
      </div>

      {/* Insights */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-text-muted border-t border-border/30 pt-2">
        {hasHighlight && diff !== 0 && (
          <span className={diff > 0 ? "text-cyan-400" : "text-amber-400"}>
            {diff > 0 ? "+" : "-"}
            {fmtMinsFull(Math.abs(diff))} ({diffPct}% {diff > 0 ? "above" : "below"} avg)
          </span>
        )}
        {hasHighlight && diff === 0 && <span>At average</span>}
        <span>
          Peak: {best.dayLabel} {best.dateLabel} — {fmtMinsFull(best.minutes)}
        </span>
        {data.length > 1 && best !== least && (
          <span>
            Low: {least.dayLabel} {least.dateLabel} — {fmtMinsFull(least.minutes)}
          </span>
        )}
      </div>
    </div>
  );
}
