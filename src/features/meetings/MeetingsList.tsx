import { Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Meeting } from "@/lib/api";
import { useMeetingsList, useMeetingActions } from "./useMeetings";

function fmt(tsSecs: number) {
  return new Date(tsSecs * 1000).toLocaleString();
}

export function MeetingsList({
  onSelect,
  selectedId,
}: {
  onSelect: (m: Meeting) => void;
  selectedId: number | null;
}) {
  const { data: meetings = [], isLoading } = useMeetingsList();
  const { remove } = useMeetingActions();

  if (isLoading)
    return (
      <div className="px-5 py-4 font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted">
        Loading…
      </div>
    );
  if (meetings.length === 0)
    return (
      <div className="px-5 py-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          Empty
        </div>
        <p className="mt-2.5 text-[13px] leading-normal text-text-muted">
          No meetings yet. Start recording to capture one.
        </p>
      </div>
    );

  return (
    <ul>
      {meetings.map((m) => {
        const active = m.id === selectedId;
        const recording = m.ended_at == null;
        return (
          <li
            key={m.id}
            className={cn(
              "group relative grid grid-cols-[1fr_auto] items-center gap-2 px-5 py-3.25 border-b border-line transition-colors",
              active ? "bg-panel" : "hover:bg-panel/60",
            )}
          >
            {active && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 bg-accent" />
            )}
            <button className="min-w-0 text-left" onClick={() => onSelect(m)}>
              <div
                className={cn(
                  "font-display text-[15px] tracking-tight truncate transition-colors",
                  active ? "text-text-primary" : "text-text-secondary group-hover:text-text-primary",
                )}
              >
                {m.title ?? "Untitled meeting"}
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.04em] text-text-faint">
                <span className="truncate">{fmt(m.started_at)}</span>
                {recording && (
                  <span className="inline-flex items-center gap-1 text-signal-error">
                    <span className="size-1.5 rounded-full bg-signal-error animate-led-pulse" />
                    recording
                  </span>
                )}
              </div>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove.mutate(m.id);
              }}
              disabled={recording}
              className="rounded-[6px] p-1.5 text-text-faint opacity-0 transition-all hover:text-signal-error group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
              aria-label="Delete meeting"
              title={recording ? "Stop the recording before deleting" : "Delete meeting"}
            >
              <Trash2 className="size-[15px]" strokeWidth={1.7} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
