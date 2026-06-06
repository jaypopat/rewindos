import type { TranscriptSegment, Meeting } from "@/lib/api";

function mmss(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function TranscriptReader({
  meeting, segments, onSeek, onJumpToTime,
}: {
  meeting: Meeting;
  segments: TranscriptSegment[];
  onSeek: (seconds: number) => void;
  onJumpToTime?: (unixSecs: number) => void;
}) {
  if (segments.length === 0)
    return <div className="p-4 text-sm text-text-muted">No transcript yet.</div>;

  return (
    <div className="space-y-2 p-4">
      {segments.map((seg) => {
        const isYou = seg.speaker_label === "You";
        return (
          <div key={seg.id} className={`flex ${isYou ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
              isYou ? "bg-accent/15 text-text-primary" : "bg-surface-overlay text-text-secondary"
            }`}>
              <div className="flex items-center gap-2 text-[10px] text-text-muted mb-0.5">
                <span>{seg.speaker_label}</span>
                <button className="underline hover:text-accent" onClick={() => onSeek(seg.start_ms / 1000)}>
                  {mmss(seg.start_ms)}
                </button>
                {onJumpToTime && (
                  <button
                    className="hover:text-accent"
                    title="Jump to this moment in Rewind"
                    aria-label="Jump to screenshot"
                    onClick={() => onJumpToTime(meeting.started_at + Math.floor(seg.start_ms / 1000))}
                  >
                    ↪ screen
                  </button>
                )}
              </div>
              {seg.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}
