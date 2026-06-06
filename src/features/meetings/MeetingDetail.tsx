import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { getMeetingSegments, type Meeting } from "@/lib/api";
import { AudioPlayer, type AudioHandle } from "./AudioPlayer";
import { TranscriptReader } from "./TranscriptReader";

export function MeetingDetail({
  meeting, onJumpToTime,
}: {
  meeting: Meeting;
  onJumpToTime?: (unixSecs: number) => void;
}) {
  const audio = useRef<AudioHandle>(null);
  const { data: segments = [] } = useQuery({
    queryKey: queryKeys.meetingSegments(meeting.id),
    queryFn: () => getMeetingSegments(meeting.id),
    staleTime: 15_000,
  });

  const audioPath = meeting.mic_audio_path ?? meeting.system_audio_path;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="px-4 py-3 border-b border-border/50">
        <h2 className="text-sm font-medium text-text-primary">{meeting.title ?? "Untitled meeting"}</h2>
        {meeting.summary && (
          <div className="mt-2 text-xs text-text-secondary whitespace-pre-wrap">{meeting.summary}</div>
        )}
        {audioPath && <div className="mt-3"><AudioPlayer ref={audio} path={audioPath} /></div>}
      </div>
      <div className="flex-1 overflow-y-auto">
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
