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
  // source changes or recording starts/stops. The `alive` flag and interval
  // cleanup guard against overlapping start/poll calls across re-renders.
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

  const fillWidth = Math.min(100, level * 300);

  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <Mic className="size-3.5 shrink-0 text-text-muted" />
      <span className="shrink-0">Microphone</span>
      <select
        value={selected}
        onChange={(e) => save.mutate(e.target.value)}
        disabled={save.isPending}
        className="max-w-48 px-2 py-1 rounded-md bg-surface border border-border/50 text-text-primary disabled:opacity-50"
      >
        <option value="">System default</option>
        {sources.map((s) => (
          <option key={s.id} value={s.name}>
            {s.description}
          </option>
        ))}
      </select>
      {active ? (
        <span className="text-text-muted">recording…</span>
      ) : (
        <div className="flex items-center gap-2">
          <div className="h-2 w-28 rounded-full bg-surface-overlay overflow-hidden">
            <div
              className="h-full rounded-full bg-signal-active transition-[width] duration-75"
              style={{ width: `${fillWidth}%` }}
            />
          </div>
          {fillWidth < 2 && (
            <span className="text-text-muted">Speak — the bar should move</span>
          )}
        </div>
      )}
    </div>
  );
}
