import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { queryKeys } from "@/lib/query-keys";
import { getMeetingSegments, type Meeting } from "@/lib/api";
import { AudioPlayer, type AudioHandle } from "./AudioPlayer";
import { TranscriptReader } from "./TranscriptReader";
import { useMeetingActions } from "./useMeetings";

function EditableTitle({ meeting }: { meeting: Meeting }) {
  const { rename } = useMeetingActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const commit = () => {
      rename.mutate({ id: meeting.id, title: draft });
      setEditing(false);
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="Meeting title"
        className="w-64 px-1.5 py-0.5 text-sm font-medium rounded bg-surface border border-border/60 text-text-primary"
      />
    );
  }

  return (
    <button
      onClick={() => {
        setDraft(meeting.title ?? "");
        setEditing(true);
      }}
      className="group flex items-center gap-1.5 text-left"
      title="Rename meeting"
    >
      <h2 className="text-sm font-medium text-text-primary">
        {meeting.title ?? "Untitled meeting"}
      </h2>
      <Pencil className="size-3 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

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
        <EditableTitle meeting={meeting} />
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
