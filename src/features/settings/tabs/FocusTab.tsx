import { type AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";
import { ListInput } from "../primitives/ListInput";
import { CategoryRulesEditor } from "../primitives/CategoryRulesEditor";

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function FocusTab({ config, update }: TabProps) {
  return (
    <>
      <SectionTitle>Pomodoro Timer</SectionTitle>
      <Field label="Work (minutes)">
        <NumberInput
          value={config.focus.work_minutes}
          min={1}
          max={120}
          onChange={(v) => update("focus", "work_minutes", v)}
        />
      </Field>
      <Field label="Short Break (minutes)">
        <NumberInput
          value={config.focus.short_break_minutes}
          min={1}
          max={30}
          onChange={(v) => update("focus", "short_break_minutes", v)}
        />
      </Field>
      <Field label="Long Break (minutes)">
        <NumberInput
          value={config.focus.long_break_minutes}
          min={1}
          max={60}
          onChange={(v) => update("focus", "long_break_minutes", v)}
        />
      </Field>
      <Field label="Sessions Before Long Break">
        <NumberInput
          value={config.focus.sessions_before_long_break}
          min={2}
          max={10}
          onChange={(v) => update("focus", "sessions_before_long_break", v)}
        />
      </Field>
      <Field label="Auto-start Breaks">
        <Toggle
          checked={config.focus.auto_start_breaks}
          onChange={(v) => update("focus", "auto_start_breaks", v)}
        />
      </Field>
      <Field label="Auto-start Work">
        <Toggle
          checked={config.focus.auto_start_work}
          onChange={(v) => update("focus", "auto_start_work", v)}
        />
      </Field>

      <SectionTitle>Productivity</SectionTitle>
      <Field label="Daily Goal (minutes)">
        <NumberInput
          value={config.focus.daily_goal_minutes}
          min={30}
          max={960}
          onChange={(v) => update("focus", "daily_goal_minutes", v)}
        />
      </Field>
      <Field label="Distraction Apps">
        <ListInput
          values={config.focus.distraction_apps}
          onChange={(v) => update("focus", "distraction_apps", v)}
          placeholder="app name"
        />
      </Field>

      <SectionTitle>Activity Categories</SectionTitle>
      <p className="text-xs text-text-muted -mt-2">
        Add app keywords to categories. These extend the built-in defaults.
      </p>
      <CategoryRulesEditor
        rules={config.focus.category_rules ?? {}}
        onChange={(rules) => update("focus", "category_rules", rules)}
      />
    </>
  );
}
