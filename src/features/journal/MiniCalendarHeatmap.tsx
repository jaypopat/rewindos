import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { dateToKey } from "@/lib/time-ranges";
import { type JournalDateInfo } from "@/lib/api";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
} from "date-fns";
import { MOOD_EMOJIS } from "./constants";

interface MiniCalendarHeatmapProps {
  selectedDate: Date;
  calendarMonth: Date;
  journalDateMap: Map<string, JournalDateInfo>;
  onSelectDate: (d: Date) => void;
}

export function MiniCalendarHeatmap({
  selectedDate,
  calendarMonth,
  journalDateMap,
  onSelectDate,
}: MiniCalendarHeatmapProps) {
  const [viewMonth, setViewMonth] = useState(calendarMonth);

  useEffect(() => {
    setViewMonth(startOfMonth(selectedDate));
  }, [selectedDate]);

  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(viewMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const today = new Date();

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth((m) => subMonths(m, 1))}
          className="p-0.5 text-text-muted hover:text-text-secondary transition-colors"
        >
          <ChevronLeft className="size-3.5" strokeWidth={2} />
        </button>
        <span className="text-xs font-medium text-text-secondary">
          {format(viewMonth, "MMMM yyyy")}
        </span>
        <button
          onClick={() => setViewMonth((m) => addMonths(m, 1))}
          className="p-0.5 text-text-muted hover:text-text-secondary transition-colors"
        >
          <ChevronRight className="size-3.5" strokeWidth={2} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-0.5 mb-0.5">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <div key={i} className="text-center text-[9px] text-text-muted font-mono py-0.5">
            {d}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((day) => {
          const key = dateToKey(day);
          const info = journalDateMap.get(key);
          const hasEntry = !!info;
          const isSelected = isSameDay(day, selectedDate);
          const isCurrentMonth = isSameMonth(day, viewMonth);
          const isCurrentDay = isSameDay(day, today);
          const isFuture = day > today;

          // Intensity based on word count
          const wc = info?.word_count ?? 0;
          const intensityClass =
            wc === 0
              ? ""
              : wc < 50
                ? "bg-emerald-500/10"
                : wc < 150
                  ? "bg-emerald-500/20"
                  : wc < 400
                    ? "bg-emerald-500/30"
                    : "bg-emerald-500/40";

          return (
            <button
              key={key}
              onClick={() => !isFuture && onSelectDate(day)}
              disabled={isFuture}
              title={hasEntry ? `${wc} words${info?.mood ? ` ${MOOD_EMOJIS[(info.mood || 3) - 1]}` : ""}` : undefined}
              className={cn(
                "relative flex items-center justify-center w-full aspect-square text-[10px] rounded transition-colors",
                !isCurrentMonth && "opacity-30",
                isFuture && "opacity-20 cursor-not-allowed",
                hasEntry && !isSelected && intensityClass,
                isSelected
                  ? "ring-1 ring-accent/60 bg-accent/20 text-accent font-medium"
                  : isCurrentDay
                    ? "text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-surface-raised",
              )}
            >
              {format(day, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
