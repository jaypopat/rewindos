import { useState } from "react";
import { Mic, Square } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useMeetingActions, useMeetingStatus } from "./useMeetings";

export function RecordingControls() {
  const { data: status } = useMeetingStatus();
  const { start, stop } = useMeetingActions();
  const [title, setTitle] = useState("");
  const active = status?.meeting_active ?? false;

  const rawError = active
    ? stop.error
      ? String(stop.error)
      : null
    : start.error
      ? String(start.error)
      : null;
  // The D-Bus calls fail with a "dbus call: ..." string when the daemon isn't
  // running — translate that into something actionable rather than raw IPC noise.
  const error = rawError
    ? rawError.includes("dbus")
      ? "Couldn't reach the recorder — is the rewindos daemon running?"
      : rawError
    : null;

  return (
    <div className="flex flex-col items-end gap-1">
      {active ? (
        <button type="button"
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 text-sm hover:bg-red-500/25 disabled:opacity-50"
        >
          <Square className="size-3.5" /> {stop.isPending ? "Stopping..." : "Stop recording"}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title (optional)"
            className="w-56 bg-surface text-sm"
          />
          <button type="button"
            onClick={() => start.mutate(title || "Untitled meeting")}
            disabled={start.isPending}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/15 text-accent text-sm hover:bg-accent/25 disabled:opacity-50"
          >
            <Mic className="size-3.5" /> {start.isPending ? "Starting..." : "Start recording"}
          </button>
        </div>
      )}
      {error && <p className="max-w-xs text-right text-xs text-red-400">{error}</p>}
    </div>
  );
}
