import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { queryKeys } from "@/lib/query-keys";
import {
  listAudioSources,
  startMicMonitor,
  stopMicMonitor,
  getMicLevel,
  updateConfig,
} from "@/lib/api";
import type { AppConfig } from "@/lib/config";
import { useConfigQuery } from "@/hooks/useConfigQuery";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Radix Select reserves "" — use a sentinel for "system default".
const DEFAULT = "__default__";

export function MicPicker({ active }: { active: boolean }) {
  const { data: config } = useConfigQuery();
  const { data: sources = [] } = useQuery({
    queryKey: queryKeys.audioSources(),
    queryFn: listAudioSources,
    staleTime: 30_000,
  });
  const qc = useQueryClient();
  const selected = config?.meeting.mic_source ?? "";
  const [level, setLevel] = useState(0);

  const save = useMutation({
    mutationFn: async (name: string) => {
      if (!config) return;
      await updateConfig({
        ...config,
        meeting: { ...config.meeting, mic_source: name },
      } as unknown as Record<string, unknown>);
    },
    onSuccess: (_d, name) => {
      qc.setQueryData(queryKeys.config(), (old: AppConfig | undefined) =>
        old ? { ...old, meeting: { ...old.meeting, mic_source: name } } : old,
      );
      qc.invalidateQueries({ queryKey: queryKeys.config() });
    },
  });

  // Live level-meter lifecycle: when not recording, open a preview monitor on
  // the selected source and poll its RMS level every 100ms. Re-runs whenever the
  // source changes or recording starts/stops.
  useEffect(() => {
    if (active || config === undefined) {
      setLevel(0);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    (async () => {
      try {
        await startMicMonitor(selected);
      } catch {
        /* daemon may be down */
      }
      timer = window.setInterval(async () => {
        try {
          const l = await getMicLevel();
          if (alive) setLevel(l);
        } catch {
          /* ignore */
        }
      }, 100);
    })();
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
      void stopMicMonitor().catch(() => {});
    };
  }, [selected, active, config === undefined]);

  // RMS for speech sits around 0.05–0.3; ×280 maps that to a usable bar.
  const fillWidth = Math.min(100, level * 280);
  const hasSignal = fillWidth >= 3;

  return (
    <div className="flex items-center gap-2.5 text-[13px] text-text-secondary">
      <Mic className="size-3.5 shrink-0 text-text-muted" strokeWidth={1.7} />
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-text-faint">
        Microphone
      </span>

      <Select
        value={selected === "" ? DEFAULT : selected}
        onValueChange={(v) => save.mutate(v === DEFAULT ? "" : v)}
        disabled={save.isPending}
      >
        <SelectTrigger className="h-8 w-56 text-[13px]">
          <SelectValue placeholder="System default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>System default</SelectItem>
          {sources.map((s) => (
            <SelectItem key={s.id} value={s.name}>
              {s.description}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {active ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-signal-error">
          <span className="size-1.5 rounded-full bg-signal-error animate-led-pulse" />
          recording
        </span>
      ) : (
        <div className="flex items-center gap-2.5">
          {/* Visible track even at zero (hairline border, raised surface). */}
          <div className="h-1.5 w-32 overflow-hidden rounded-full border border-line-hi bg-line-2">
            <div
              className="h-full rounded-full bg-signal-active transition-[width] duration-75"
              style={{ width: `${fillWidth}%` }}
            />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint">
            {hasSignal ? "input detected" : "speak to test"}
          </span>
        </div>
      )}
    </div>
  );
}
