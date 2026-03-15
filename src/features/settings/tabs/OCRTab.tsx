import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";

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
      <Field label="Engine">
        <Select value={config.ocr.engine} onValueChange={(v) => update("ocr", "engine", v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tesseract">Tesseract</SelectItem>
            <SelectItem value="paddleocr">PaddleOCR</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {config.ocr.engine === "tesseract" && (
        <Field label="Tesseract Language">
          <TextInput
            value={config.ocr.tesseract_lang}
            onChange={(v) => update("ocr", "tesseract_lang", v)}
          />
        </Field>
      )}
      {config.ocr.engine === "paddleocr" && (
        <Field label="Model Directory">
          <TextInput
            value={config.ocr.model_dir}
            onChange={(v) => update("ocr", "model_dir", v)}
          />
        </Field>
      )}
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
