import { useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="flex flex-col items-end gap-1.5">
      {active ? (
        <Button type="button"
          variant="ghost"
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          className="inline-flex items-center gap-2 h-9 px-[15px] rounded-lg text-[13px] font-semibold text-signal-error border border-signal-error/35 bg-signal-error/10 hover:bg-signal-error/18"
        >
          <Square className="size-[13px] fill-current" strokeWidth={0} />
          {stop.isPending ? "Stopping…" : "Stop recording"}
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title (optional)"
            className="h-9 w-56"
          />
          <Button type="button"
            variant="default"
            onClick={() => start.mutate(title || "Untitled meeting")}
            disabled={start.isPending}
            className="inline-flex items-center gap-2 h-9 px-[15px] rounded-lg text-[13px] font-semibold bg-accent text-[#1c1208] border border-accent-deep hover:bg-accent-hi"
          >
            <Mic className="size-[15px]" strokeWidth={1.8} />
            {start.isPending ? "Starting…" : "Start recording"}
          </Button>
        </div>
      )}
      {error && <p className="max-w-xs text-right text-xs text-signal-error">{error}</p>}
    </div>
  );
}
