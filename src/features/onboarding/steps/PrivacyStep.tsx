import { useConfig } from "@/features/settings/hooks/useConfig";
import { ListInput } from "@/features/settings/primitives/ListInput";

export function PrivacyStep() {
  const { config, update, saving, saved } = useConfig();

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-text-primary">Your privacy</h2>
      <p className="text-sm leading-relaxed text-text-secondary">
        Private and incognito browser windows are excluded automatically. You can also
        exclude specific apps (for example, a password manager) — RewindOS won't capture
        while they're focused.
      </p>
      <p className="text-xs leading-relaxed text-text-muted">
        Capture is <span className="font-medium text-text-secondary">fail-closed</span>: if
        it can't read which app is in front, it pauses rather than risk capturing something
        you excluded.
      </p>

      {config ? (
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
            Excluded apps
          </span>
          <ListInput
            values={config.privacy.excluded_apps}
            onChange={(v) => update("privacy", "excluded_apps", v)}
            placeholder="app name"
          />
          <div className="flex items-center gap-3">
            {(saving || saved) && (
              <span className="font-mono text-[11px] text-text-muted">
                {saving ? "saving…" : "saved"}
              </span>
            )}
            <span className="text-xs text-text-muted">More options in Settings → Privacy.</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-text-muted">Loading current settings…</p>
      )}
    </div>
  );
}
