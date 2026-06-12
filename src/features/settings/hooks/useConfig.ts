import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateConfig } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { AppConfig } from "@/lib/config";
import { useConfigQuery } from "@/hooks/useConfigQuery";
import { useDebounce } from "@/hooks/useDebounce";

const AUTOSAVE_DELAY_MS = 800;

export function useConfig() {
  const { data: fetchedConfig, error: fetchError } = useConfigQuery();
  const queryClient = useQueryClient();
  const [localEdits, setLocalEdits] = useState<AppConfig | null>(null);
  const [saved, setSaved] = useState(false);

  // Derive config: local edits take priority, otherwise use fetched data
  const config = localEdits ?? fetchedConfig ?? null;

  const saveMutation = useMutation({
    mutationFn: (c: AppConfig) =>
      updateConfig(c as unknown as Record<string, unknown>),
    onSuccess: (_data, sent) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.config() });
      // Clear the buffer only if no newer edits arrived while this save was
      // in flight; otherwise keep them for the follow-up save.
      setLocalEdits((prev) => (prev === sent ? null : prev));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  // Last snapshot we attempted to save — used to avoid hot-looping a retry
  // of a value that just failed. A new edit is a new object and retries.
  const lastSentRef = useRef<AppConfig | null>(null);
  const saveMutate = saveMutation.mutate;
  const saveNow = useCallback(
    (c: AppConfig) => {
      lastSentRef.current = c;
      saveMutate(c);
    },
    [saveMutate],
  );

  // ── Debounced auto-save (same pattern as useJournalEntry) ──
  // Only save when the debounced snapshot has caught up with the live edits;
  // when a save is in flight, this effect re-runs on settle and picks up
  // anything typed in the meantime.
  const debouncedEdits = useDebounce(localEdits, AUTOSAVE_DELAY_MS);
  useEffect(() => {
    if (debouncedEdits == null) return;
    if (debouncedEdits !== localEdits) return; // debounce not caught up yet
    if (saveMutation.isPending) return; // re-runs when the save settles
    if (saveMutation.isError && lastSentRef.current === debouncedEdits) return;
    saveNow(debouncedEdits);
  }, [
    debouncedEdits,
    localEdits,
    saveMutation.isPending,
    saveMutation.isError,
    saveNow,
  ]);

  // Immediate save — wired to blur in SettingsView; also retries a failed
  // value explicitly (unlike the auto-save effect).
  const flush = useCallback(() => {
    if (localEdits == null || saveMutation.isPending) return;
    saveNow(localEdits);
  }, [localEdits, saveMutation.isPending, saveNow]);

  // Flush on unmount so leaving the view mid-debounce never loses edits.
  // (The mutation lives in the TanStack mutation cache and survives unmount.)
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    return () => {
      flushRef.current();
    };
  }, []);

  const update = useCallback(
    <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
      section: S,
      key: K,
      value: AppConfig[S][K],
    ) => {
      setLocalEdits((prev) => {
        const base = prev ?? fetchedConfig ?? null;
        if (!base) return prev;
        return { ...base, [section]: { ...base[section], [key]: value } };
      });
    },
    [fetchedConfig],
  );

  return {
    config,
    saving: saveMutation.isPending,
    saved,
    error: saveMutation.error ? String(saveMutation.error) : fetchError ? String(fetchError) : null,
    flush,
    update,
  };
}
