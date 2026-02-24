import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function OCRTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>OCR</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.ocr.enabled}
          onChange={(v) => update("ocr", "enabled", v)}
        />
      </Field>
      <Field label="Tesseract Language">
        <TextInput
          value={config.ocr.tesseract_lang}
          onChange={(v) => update("ocr", "tesseract_lang", v)}
        />
      </Field>
      <Field label="Max Workers">
        <NumberInput
          value={config.ocr.max_workers}
          min={1}
          max={8}
          onChange={(v) => update("ocr", "max_workers", v)}
        />
      </Field>
    </>
  );
}
