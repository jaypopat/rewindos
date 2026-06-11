import type { AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { Button } from "@/components/ui/button";
import { useOnboarding } from "@/features/onboarding/OnboardingContext";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function GeneralTab({ config, update }: TabProps) {
  const { open } = useOnboarding();
  return (
    <>
      <SectionTitle>General</SectionTitle>
      <Field label="Global Hotkey">
        <TextInput
          value={config.ui.global_hotkey}
          onChange={(v) => update("ui", "global_hotkey", v)}
        />
      </Field>
      <Field label="Setup">
        <Button variant="outline" size="xs" onClick={open}>
          Run setup again
        </Button>
      </Field>
    </>
  );
}
