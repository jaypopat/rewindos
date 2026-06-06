import { useState } from "react";
import { Mic, Square } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateConfig } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useConfigQuery } from "@/hooks/useConfigQuery";
import { useMeetingActions, useMeetingStatus } from "./useMeetings";
import { MeetingConsentDialog } from "./MeetingConsentDialog";

export function RecordingControls() {
  const { data: status } = useMeetingStatus();
  const { data: config } = useConfigQuery();
  const { start, stop } = useMeetingActions();
  const [title, setTitle] = useState("");
  const [consentOpen, setConsentOpen] = useState(false);
  const qc = useQueryClient();
  const active = status?.meeting_active ?? false;

  const ackConsent = useMutation({
    mutationFn: async () => {
      if (!config) throw new Error("config not loaded");
      const next = {
        ...config,
        meeting: { ...config.meeting, consent_acknowledged: true },
      };
      await updateConfig(next as unknown as Record<string, unknown>);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.config() }),
  });

  const tryStart = () => {
    if (config?.meeting.consent_acknowledged) {
      start.mutate(title || "Untitled meeting");
    } else {
      setConsentOpen(true);
    }
  };

  const agreeAndStart = async () => {
    await ackConsent.mutateAsync();
    start.mutate(title || "Untitled meeting");
    setConsentOpen(false);
  };

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
        onClick={tryStart}
        disabled={start.isPending}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/15 text-accent text-sm hover:bg-accent/25"
      >
        <Mic className="size-3.5" /> {start.isPending ? "Starting…" : "Start recording"}
      </button>
      {consentOpen && (
        <MeetingConsentDialog
          onAgree={agreeAndStart}
          onCancel={() => setConsentOpen(false)}
          busy={ackConsent.isPending || start.isPending}
        />
      )}
    </div>
  );
}
