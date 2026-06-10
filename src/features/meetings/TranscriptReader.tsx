import { cn } from "@/lib/utils";
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
    return (
      <div className="px-7 py-6">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint">
          Transcript
        </div>
        <p className="mt-2.5 text-[13px] text-text-muted">No transcript yet.</p>
      </div>
    );

  return (
    <div className="px-7 py-6 max-w-[74ch]">
      {segments.map((seg) => {
        const isYou = seg.speaker_label === "You";
        return (
          <div key={seg.id} className="group mb-5 last:mb-0">
            <div className="flex items-baseline gap-2.5">
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-widest",
                  isYou ? "text-accent-hi" : "text-text-muted",
                )}
              >
                {seg.speaker_label}
              </span>
              <button
                className="font-mono text-[10px] tabular-nums text-text-faint transition-colors hover:text-accent"
                onClick={() => onSeek(seg.start_ms / 1000)}
                title="Play from here"
              >
                {mmss(seg.start_ms)}
              </button>
              {onJumpToTime && (
                <button
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint opacity-0 transition-all hover:text-accent group-hover:opacity-100"
                  title="Jump to this moment in Rewind"
                  aria-label="Jump to screenshot"
                  onClick={() => onJumpToTime(meeting.started_at + Math.floor(seg.start_ms / 1000))}
                >
                  ↪ screen
                </button>
              )}
            </div>
            <p className="mt-1 text-[14px] leading-[1.68] text-text-secondary">{seg.text}</p>
          </div>
        );
      })}
    </div>
  );
}
