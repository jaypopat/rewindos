import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateConfig } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { type AppConfig } from "@/lib/config";
import { useConfigQuery } from "@/hooks/useConfigQuery";

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.config() });
      setLocalEdits(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSave = useCallback(() => {
    if (!config) return;
    saveMutation.mutate(config);
  }, [config, saveMutation]);

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
    handleSave,
    update,
  };
}
