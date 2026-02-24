import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function StorageTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>Storage</SectionTitle>
      <Field label="Base Directory">
        <TextInput
          value={config.storage.base_dir}
          onChange={(v) => update("storage", "base_dir", v)}
        />
      </Field>
      <Field label="Retention (days)">
        <NumberInput
          value={config.storage.retention_days}
          min={7}
          max={365}
          onChange={(v) => update("storage", "retention_days", v)}
        />
      </Field>
      <Field label="Screenshot Quality (0-100)">
        <NumberInput
          value={config.storage.screenshot_quality}
          min={1}
          max={100}
          onChange={(v) => update("storage", "screenshot_quality", v)}
        />
      </Field>
      <Field label="Thumbnail Width (px)">
        <NumberInput
          value={config.storage.thumbnail_width}
          min={100}
          max={800}
          onChange={(v) => update("storage", "thumbnail_width", v)}
        />
      </Field>
    </>
  );
}
