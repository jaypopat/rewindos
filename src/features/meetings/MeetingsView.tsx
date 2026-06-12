import { useState } from "react";
import type { Meeting } from "@/lib/api";
import { MeetingsList } from "./MeetingsList";
import { RecordingControls } from "./RecordingControls";
import { MeetingDetail } from "./MeetingDetail";
import { MicPicker } from "./MicPicker";
import { useMeetingsList, useMeetingStatus } from "./useMeetings";

export function MeetingsView({ onJumpToTime }: { onJumpToTime?: (unixSecs: number) => void }) {
  const [selected, setSelected] = useState<Meeting | null>(null);
  const { data: meetings = [] } = useMeetingsList();
  const { data: status } = useMeetingStatus();
  const active = status?.meeting_active ?? false;

  // Track the live row from the refetched list so stopping/deleting the
  // selected meeting updates (or clears) the detail pane instead of showing
  // a stale snapshot.
  const liveSelected = selected
    ? (meetings.find((m) => m.id === selected.id) ?? null)
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="flex flex-col gap-3.5 px-7 py-[18px] border-b border-line shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="kicker">
            Recorder
            <span className="mx-2 text-text-ghost">/</span>
            <span className="text-text-secondary">
              {meetings.length} {meetings.length === 1 ? "session" : "sessions"}
            </span>
          </div>
          <RecordingControls />
        </div>
        <MicPicker active={active} />
      </header>
      <div className="flex-1 flex min-h-0">
        <div className="w-[300px] border-r border-line overflow-y-auto shrink-0">
          <MeetingsList onSelect={setSelected} selectedId={liveSelected?.id ?? null} />
        </div>
        <div className="flex-1 overflow-y-auto">
          {liveSelected ? (
            <MeetingDetail meeting={liveSelected} onJumpToTime={onJumpToTime} />
          ) : (
            <div className="flex h-full items-center justify-center px-8">
              <div className="text-center">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
                  No session selected
                </div>
                <p className="mt-3 font-display text-[19px] tracking-tight text-text-secondary">
                  Pick a meeting to read its transcript.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
