import { useState } from "react";
import { Mic, Square } from "lucide-react";
import { useMeetingActions, useMeetingStatus } from "./useMeetings";

export function RecordingControls({ onNeedsConsent }: { onNeedsConsent: () => boolean }) {
  const { data: status } = useMeetingStatus();
  const { start, stop } = useMeetingActions();
  const [title, setTitle] = useState("");
  const active = status?.meeting_active ?? false;

  if (active) {
    return (
      <button
        onClick={() => stop.mutate()}
        disabled={stop.isPending}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 text-sm hover:bg-red-500/25"
      >
        <Square className="size-3.5" /> {stop.isPending ? "Stopping…" : "Stop recording"}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Meeting title (optional)"
        className="px-2 py-1.5 text-sm rounded-md bg-surface border border-border/50"
      />
      <button
        onClick={() => { if (onNeedsConsent()) start.mutate(title || "Untitled meeting"); }}
        disabled={start.isPending}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/15 text-accent text-sm hover:bg-accent/25"
      >
        <Mic className="size-3.5" /> {start.isPending ? "Starting…" : "Start recording"}
      </button>
    </div>
  );
}
