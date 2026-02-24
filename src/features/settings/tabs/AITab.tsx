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

export function AITab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>Chat / Ask</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.chat.enabled}
          onChange={(v) => update("chat", "enabled", v)}
        />
      </Field>
      <Field label="Ollama URL">
        <TextInput
          value={config.chat.ollama_url}
          onChange={(v) => update("chat", "ollama_url", v)}
        />
      </Field>
      <Field label="Model">
        <TextInput
          value={config.chat.model}
          onChange={(v) => update("chat", "model", v)}
        />
      </Field>
      <Field label="Temperature">
        <NumberInput
          value={config.chat.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(v) => update("chat", "temperature", v)}
        />
      </Field>
      <Field label="Max History Messages">
        <NumberInput
          value={config.chat.max_history_messages}
          min={2}
          max={50}
          onChange={(v) => update("chat", "max_history_messages", v)}
        />
      </Field>

      <SectionTitle>Semantic Search (Embeddings)</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.semantic.enabled}
          onChange={(v) => update("semantic", "enabled", v)}
        />
      </Field>
      <Field label="Embedding Model">
        <TextInput
          value={config.semantic.model}
          onChange={(v) => update("semantic", "model", v)}
        />
      </Field>
    </>
  );
}
