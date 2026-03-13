import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createCollection } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { X, Clock } from "lucide-react";

interface SaveMomentDialogProps {
  onClose: () => void;
}

function toUnixTimestamp(dateStr: string, timeStr: string): number {
  const date = new Date(`${dateStr}T${timeStr}`);
  return Math.floor(date.getTime() / 1000);
}

function defaultStartTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:00`;
}

function defaultEndTime(): string {
  const now = new Date();
  const hour = Math.min(now.getHours() + 1, 23);
  return `${String(hour).padStart(2, "0")}:00`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTimeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function SaveMomentDialog({ onClose }: SaveMomentDialogProps) {
  const [date, setDate] = useState(todayStr);
  const [startTime, setStartTime] = useState(defaultStartTime);
  const [endTime, setEndTime] = useState(defaultEndTime);
  const [name, setName] = useState("");
  const queryClient = useQueryClient();

  const autoName = `${formatTimeLabel(startTime)} \u2013 ${formatTimeLabel(endTime)}`;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const start = toUnixTimestamp(date, startTime);
      const end = toUnixTimestamp(date, endTime);
      if (end <= start) throw new Error("End time must be after start time");
      return createCollection({
        name: name.trim() || autoName,
        start_time: start,
        end_time: end,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.collections() });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-surface border border-border/50 rounded-xl shadow-xl w-[400px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-accent" strokeWidth={2} />
            <h2 className="text-sm font-medium text-text-primary">Save Moment</h2>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors">
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveMutation.mutate();
          }}
          className="px-5 py-4 space-y-4"
        >
          <div>
            <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={autoName}
              className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent/50"
            />
          </div>

          <div>
            <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
              Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                Start time
              </label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                End time
              </label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50"
              />
            </div>
          </div>

          {saveMutation.isError && (
            <p className="text-[10px] text-red-400">{(saveMutation.error as Error).message}</p>
          )}

          <button
            type="submit"
            disabled={saveMutation.isPending}
            className="w-full flex items-center justify-center gap-2 bg-accent/15 hover:bg-accent/25 text-accent text-xs font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {saveMutation.isPending ? (
              <div className="w-3 h-3 border border-accent/30 border-t-accent rounded-full animate-spin" />
            ) : (
              <Clock className="size-3" strokeWidth={2} />
            )}
            Save Moment
          </button>
        </form>
      </div>
    </div>
  );
}
