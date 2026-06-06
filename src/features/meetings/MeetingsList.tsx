import { CalendarClock, Trash2 } from "lucide-react";
import type { Meeting } from "@/lib/api";
import { useMeetingsList, useMeetingActions } from "./useMeetings";

function fmt(tsSecs: number) {
  return new Date(tsSecs * 1000).toLocaleString();
}

export function MeetingsList({ onSelect }: { onSelect: (m: Meeting) => void }) {
  const { data: meetings = [], isLoading } = useMeetingsList();
  const { remove } = useMeetingActions();

  if (isLoading) return <div className="p-4 text-sm text-text-muted">Loading…</div>;
  if (meetings.length === 0)
    return <div className="p-4 text-sm text-text-muted">No meetings yet. Start recording to capture one.</div>;

  return (
    <ul className="divide-y divide-border/40">
      {meetings.map((m) => (
        <li key={m.id} className="flex items-center justify-between px-4 py-3 hover:bg-surface-overlay/40">
          <button className="flex-1 text-left" onClick={() => onSelect(m)}>
            <div className="text-sm text-text-primary">{m.title ?? "Untitled meeting"}</div>
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <CalendarClock className="size-3" /> {fmt(m.started_at)}
              {m.ended_at == null && <span className="text-red-400">• recording</span>}
            </div>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); remove.mutate(m.id); }}
            disabled={m.ended_at == null}
            className="p-1.5 text-text-muted hover:text-red-400 disabled:opacity-30 disabled:hover:text-text-muted disabled:cursor-not-allowed"
            aria-label="Delete meeting"
            title={m.ended_at == null ? "Stop the recording before deleting" : "Delete meeting"}
          >
            <Trash2 className="size-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}
