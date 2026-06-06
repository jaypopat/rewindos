import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type AppConfig } from "@/lib/config";
import { queryKeys } from "@/lib/query-keys";
import { whisperModelPresent, downloadWhisperModel } from "@/lib/api";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { Toggle } from "../primitives/Toggle";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function MeetingTab({ config, update }: TabProps) {
  const qc = useQueryClient();
  const { data: present } = useQuery({
    queryKey: queryKeys.whisperModel(),
    queryFn: whisperModelPresent,
    staleTime: 10_000,
  });
  const download = useMutation({
    mutationFn: downloadWhisperModel,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.whisperModel() }),
  });

  return (
    <>
      <SectionTitle>Meetings</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.meeting.enabled}
          onChange={(v) => update("meeting", "enabled", v)}
        />
      </Field>
      <Field label="Whisper model">
        <TextInput
          value={config.meeting.model}
          onChange={(v) => update("meeting", "model", v)}
        />
      </Field>
      <Field label="Keep audio after transcription">
        <Toggle
          checked={config.meeting.keep_audio}
          onChange={(v) => update("meeting", "keep_audio", v)}
        />
      </Field>
      <Field label="AI summary">
        <Toggle
          checked={config.meeting.summary_enabled}
          onChange={(v) => update("meeting", "summary_enabled", v)}
        />
      </Field>
      <Field label="Toggle hotkey">
        <TextInput
          value={config.meeting.hotkey}
          onChange={(v) => update("meeting", "hotkey", v)}
        />
      </Field>

      <SectionTitle>Whisper model</SectionTitle>
      <Field label="Status">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              present ? "bg-signal-success" : "bg-text-muted/40"
            }`}
          />
          <span className="font-mono text-xs text-text-secondary">
            {present === undefined
              ? "checking..."
              : present
                ? `ggml-${config.meeting.model}.bin present`
                : "not downloaded"}
          </span>
        </div>
      </Field>
      {present === false && (
        <Field label="">
          <button
            onClick={() => download.mutate()}
            disabled={download.isPending}
            className="font-mono text-xs px-3 py-1 border border-semantic/40 text-semantic hover:bg-semantic/10 transition-all disabled:opacity-50"
          >
            {download.isPending ? "downloading... (may take minutes)" : "Download model"}
          </button>
        </Field>
      )}
      {download.isError && (
        <p className="font-mono text-[11px] text-signal-error mt-1">
          {String(download.error)}
        </p>
      )}
    </>
  );
}
