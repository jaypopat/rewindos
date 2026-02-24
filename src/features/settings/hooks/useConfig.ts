import { useCallback, useEffect, useState } from "react";
import { getConfig, updateConfig } from "@/lib/api";
import { type AppConfig } from "@/lib/config";

export function useConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => setConfig(c as unknown as AppConfig))
      .catch((e) => setError(String(e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      await updateConfig(config as unknown as Record<string, unknown>);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [config]);

  const update = useCallback(
    <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
      section: S,
      key: K,
      value: AppConfig[S][K],
    ) => {
      setConfig((prev) => {
        if (!prev) return prev;
        return { ...prev, [section]: { ...prev[section], [key]: value } };
      });
    },
    [],
  );

  return { config, saving, saved, error, handleSave, update };
}
