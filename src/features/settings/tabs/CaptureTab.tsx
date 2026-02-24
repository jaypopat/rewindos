import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function CaptureTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>Screen Capture</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.capture.enabled}
          onChange={(v) => update("capture", "enabled", v)}
        />
      </Field>
      <Field label="Interval (seconds)">
        <NumberInput
          value={config.capture.interval_seconds}
          min={1}
          max={60}
          onChange={(v) => update("capture", "interval_seconds", v)}
        />
      </Field>
      <Field label="Change Threshold">
        <NumberInput
          value={config.capture.change_threshold}
          min={0}
          max={64}
          onChange={(v) => update("capture", "change_threshold", v)}
        />
      </Field>
    </>
  );
}
