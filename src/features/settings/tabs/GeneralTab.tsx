import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function GeneralTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>General</SectionTitle>
      <Field label="Global Hotkey">
        <TextInput
          value={config.ui.global_hotkey}
          onChange={(v) => update("ui", "global_hotkey", v)}
        />
      </Field>
    </>
  );
}
