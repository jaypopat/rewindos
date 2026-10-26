import type { AppConfig } from "@/lib/config";
import { openAnalyticsDoc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { ListInput } from "../primitives/ListInput";
import { Toggle } from "../primitives/Toggle";

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
      <Field
        label="Share anonymous usage analytics"
        hint={
          <>
            Sends a random install ID, feature use, and browser, screen-size, desktop,
            and distro metadata. Session replay is disabled in this build. Never your screen history, app names,
            window titles, searches, chats, or journal text.{" "}
            <Button
              variant="link"
              size="xs"
              onClick={() => void openAnalyticsDoc()}
              className="h-auto p-0 text-[12.5px]"
            >
              See everything that is sent
            </Button>
          </>
        }
      >
        <Toggle
          checked={config.privacy.analytics}
          onChange={(v) => update("privacy", "analytics", v)}
        />
      </Field>
    </>
  );
}
