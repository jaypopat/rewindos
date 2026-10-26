import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@/lib/config";
import { queryKeys } from "@/lib/query-keys";
import { whisperModelPresent, downloadWhisperModel } from "@/lib/api";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

const ENGINE_OPTIONS = [
  { id: "whisper-cpp", label: "Whisper.cpp (built-in)" },
  { id: "whisper-cpp-server", label: "Whisper.cpp server (native, remote)" },
  { id: "openai-compatible", label: "OpenAI-compatible API" },
] as const;

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

  const engine = config.meeting.engine;

  return (
    <>
      <SectionTitle>Meetings</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.meeting.enabled}
          onChange={(v) => update("meeting", "enabled", v)}
        />
      </Field>
      <Field
        label="Transcription engine"
        hint="Where audio gets turned into text. Built-in runs fully offline on this machine; the others send audio to a server you point at."
      >
        <Select
          value={engine}
          onValueChange={(v) => update("meeting", "engine", v as typeof engine)}
        >
          <SelectTrigger className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENGINE_OPTIONS.map((o) => (
              <SelectItem key={o.id} value={o.id} className="font-mono">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {engine === "whisper-cpp" && (
        <Field label="Whisper model">
          <TextInput
            value={config.meeting.model}
            onChange={(v) => update("meeting", "model", v)}
          />
        </Field>
      )}

      {engine === "whisper-cpp-server" && (
        <>
          <Field
            label="Server URL"
            hint="Address of a whisper.cpp server instance (whisper-server). This is the native whisper.cpp HTTP API, not an OpenAI-style /v1 endpoint."
          >
            <TextInput
              value={config.meeting.service_url}
              onChange={(v) => update("meeting", "service_url", v)}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <NumberInput
              value={config.meeting.service_timeout_secs}
              min={1}
              max={3600}
              onChange={(v) => update("meeting", "service_timeout_secs", v)}
            />
          </Field>
        </>
      )}

      {engine === "openai-compatible" && (
        <>
          <Field
            label="Server URL"
            hint="Base URL of an OpenAI-compatible transcription endpoint (e.g. /v1/audio/transcriptions)."
          >
            <TextInput
              value={config.meeting.service_url}
              onChange={(v) => update("meeting", "service_url", v)}
            />
          </Field>
          <Field label="API Key" hint="Optional. Leave blank if the server doesn't require one.">
            <TextInput
              type="password"
              value={config.meeting.service_api_key}
              onChange={(v) => update("meeting", "service_api_key", v)}
              autoComplete="off"
            />
          </Field>
          <Field label="Model">
            <TextInput
              value={config.meeting.service_model}
              onChange={(v) => update("meeting", "service_model", v)}
            />
          </Field>
          <Field label="Timeout (seconds)">
            <NumberInput
              value={config.meeting.service_timeout_secs}
              min={1}
              max={3600}
              onChange={(v) => update("meeting", "service_timeout_secs", v)}
            />
          </Field>
        </>
      )}

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

      {engine === "whisper-cpp" && (
        <>
          <SectionTitle>Whisper model</SectionTitle>
          <Field label="Status">
            <div className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  present ? "bg-signal-active" : "bg-text-muted/40"
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
              <Button
                variant="editorial"
                size="editorial"
                onClick={() => download.mutate()}
                disabled={download.isPending}
              >
                {download.isPending ? "downloading... (may take minutes)" : "Download model"}
              </Button>
            </Field>
          )}
          {download.isError && (
            <p className="font-mono text-[11px] text-signal-error mt-1">
              {String(download.error)}
            </p>
          )}
        </>
      )}
    </>
  );
}
