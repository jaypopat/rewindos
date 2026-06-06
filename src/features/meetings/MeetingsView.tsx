import { useState } from "react";
import type { Meeting } from "@/lib/api";
import { MeetingsList } from "./MeetingsList";
import { RecordingControls } from "./RecordingControls";
import { MeetingDetail } from "./MeetingDetail";
import { useMeetingsList } from "./useMeetings";

export function MeetingsView({ onJumpToTime }: { onJumpToTime?: (unixSecs: number) => void }) {
  const [selected, setSelected] = useState<Meeting | null>(null);
  const { data: meetings = [] } = useMeetingsList();

  // Track the live row from the refetched list so stopping/deleting the
  // selected meeting updates (or clears) the detail pane instead of showing
  // a stale snapshot.
  const liveSelected = selected
    ? (meetings.find((m) => m.id === selected.id) ?? null)
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <h1 className="text-sm font-medium text-text-primary">Meetings</h1>
        <RecordingControls />
      </header>
      <div className="flex-1 flex min-h-0">
        <div className="w-80 border-r border-border/50 overflow-y-auto">
          <MeetingsList onSelect={setSelected} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {liveSelected ? (
            <MeetingDetail meeting={liveSelected} onJumpToTime={onJumpToTime} />
          ) : (
            <div className="p-6 text-sm text-text-muted">Select a meeting to view its transcript.</div>
          )}
        </div>
      </div>
    </div>
  );
}
