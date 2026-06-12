import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { getMeetingSegments, type Meeting } from "@/lib/api";
import { AudioPlayer, type AudioHandle } from "./AudioPlayer";
import { TranscriptReader } from "./TranscriptReader";
import { useMeetingActions } from "./useMeetings";
import { useRename } from "@/hooks/useRename";

function EditableTitle({ meeting }: { meeting: Meeting }) {
  const { rename } = useMeetingActions();
  const renaming = useRename<number>((id, title) => rename.mutate({ id, title }));

  if (renaming.isRenaming(meeting.id)) {
    return (
      <Input
        autoFocus
        value={renaming.value}
        onChange={(e) => renaming.setValue(e.target.value)}
        onBlur={renaming.commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") renaming.cancel();
        }}
        placeholder="Meeting title"
        className="h-10 w-80 rounded-[7px] font-display text-[24px] tracking-tight"
      />
    );
  }

  return (
    <Button type="button"
      variant="quiet"
      onClick={() => renaming.start(meeting.id, meeting.title ?? "")}
      className="h-auto p-0 group flex items-center gap-2.5 text-left"
      title="Rename meeting"
    >
      <h2 className="font-display text-[24px] tracking-tight text-text-primary">
        {meeting.title ?? "Untitled meeting"}
      </h2>
      <Pencil className="size-3.5 text-text-faint opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={1.7} />
    </Button>
  );
}

export function MeetingDetail({
  meeting, onJumpToTime,
}: {
  meeting: Meeting;
  onJumpToTime?: (unixSecs: number) => void;
}) {
  const audio = useRef<AudioHandle>(null);
  const [minutesOpen, setMinutesOpen] = useState(false);
  const { data: segments = [] } = useQuery({
    queryKey: queryKeys.meetingSegments(meeting.id),
    queryFn: () => getMeetingSegments(meeting.id),
    staleTime: 15_000,
  });

  const audioPath = meeting.mic_audio_path ?? meeting.system_audio_path;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Pinned header: title + audio stay visible while the transcript scrolls */}
      <div className="px-7 pt-7 pb-5 border-b border-line shrink-0">
        <EditableTitle meeting={meeting} />
        {audioPath && <div className="mt-4"><AudioPlayer ref={audio} path={audioPath} /></div>}
      </div>

      {/* Minutes — collapsed by default so the transcript is the focus on open.
          Expanded, it's capped so a long summary can't swallow the viewport. */}
      {meeting.summary && (
        <div className="border-b border-line shrink-0">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setMinutesOpen((v) => !v)}
            aria-expanded={minutesOpen}
            className="h-auto justify-start rounded-none flex w-full items-center gap-2 px-7 py-3 text-left hover:bg-panel"
          >
            <ChevronRight
              className={cn(
                "size-3.5 text-text-faint transition-transform",
                minutesOpen && "rotate-90",
              )}
              strokeWidth={1.7}
            />
            <span className="kicker">
              Minutes
            </span>
          </Button>
          {minutesOpen && (
            <div className="max-h-[40vh] overflow-y-auto px-7 pb-5">
              <p className="max-w-[68ch] text-[13px] leading-[1.6] text-text-secondary whitespace-pre-wrap">
                {meeting.summary}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Transcript fills all remaining height regardless of summary length */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TranscriptReader
          meeting={meeting}
          segments={segments}
          onSeek={(s) => audio.current?.seekTo(s)}
          onJumpToTime={onJumpToTime}
        />
      </div>
    </div>
  );
}
