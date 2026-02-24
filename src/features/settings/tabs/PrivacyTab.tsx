import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { ListInput } from "../primitives/ListInput";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function PrivacyTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>Privacy</SectionTitle>
      <Field label="Excluded Apps">
        <ListInput
          values={config.privacy.excluded_apps}
          onChange={(v) => update("privacy", "excluded_apps", v)}
          placeholder="app name"
        />
      </Field>
      <Field label="Excluded Title Patterns">
        <ListInput
          values={config.privacy.excluded_title_patterns}
          onChange={(v) => update("privacy", "excluded_title_patterns", v)}
          placeholder="pattern"
        />
      </Field>
    </>
  );
}
