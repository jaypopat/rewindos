import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  gnomeExtensionStatus,
  recheckWindowInfo,
  openExtensionPage,
  getDaemonStatus,
  setUnfilteredCapture,
} from "@/lib/api";

type State =
  | { kind: "loading" }
  | { kind: "not-installed" }
  | { kind: "installed-inactive" }
  | { kind: "active" };

export function GnomeTrackingCard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [ext, status] = await Promise.all([
      gnomeExtensionStatus().catch(() => ({ installed: false })),
      getDaemonStatus().catch(() => null),
    ]);
    const active = status?.window_info_provider === "window-calls-ext";
    if (active) setState({ kind: "active" });
    else if (ext.installed) setState({ kind: "installed-inactive" });
    else setState({ kind: "not-installed" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRecheck = useCallback(async () => {
    setBusy(true);
    try {
      await recheckWindowInfo().catch(() => {});
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const dot =
    state.kind === "active"
      ? "bg-green-500"
      : state.kind === "installed-inactive"
        ? "bg-amber-500"
        : state.kind === "loading"
          ? "bg-border"
          : "bg-red-500";

  return (
    <div className="mt-4 border border-border/60 rounded-md p-3 bg-surface/50">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${dot}`} />
        <span className="font-mono text-[11px] uppercase tracking-wider text-text-primary">
          GNOME app tracking
        </span>
      </div>

      {state.kind === "active" && (
        <p className="mt-2 text-xs text-text-muted">
          Window Calls Extended detected — app and window tracking is active.
        </p>
      )}

      {state.kind === "not-installed" && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-text-muted">
            GNOME needs the "Window Calls Extended" extension for app/window
            tracking. Install it, then toggle it on in GNOME Extensions.
          </p>
          <div className="flex gap-2">
            <Button
              variant="editorial-accent"
              size="editorial"
              onClick={() => void openExtensionPage()}
              className="h-auto px-3 py-1 text-[11px] uppercase tracking-wider text-text-primary bg-accent/10 hover:bg-accent/20"
            >
              Install
            </Button>
            <Button
              variant="editorial-muted"
              size="editorial"
              onClick={onRecheck}
              disabled={busy}
              className="h-auto px-3 py-1 text-[11px] border-border/60 hover:bg-surface hover:text-text-muted"
            >
              {busy ? "Checking…" : "Re-check"}
            </Button>
            <Button
              variant="editorial-muted"
              size="editorial"
              onClick={async () => {
                await setUnfilteredCapture(true);
                await refresh();
              }}
              className="h-auto px-3 py-1 text-[11px] border-border/60 hover:bg-surface hover:text-text-muted"
              title="Capture without enforcing app/incognito exclusions"
            >
              Capture anyway
            </Button>
          </div>
        </div>
      )}

      {state.kind === "installed-inactive" && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-text-muted">
            Extension detected but not yet active. Click re-check to activate
            tracking without restarting.
          </p>
          <Button
            variant="editorial-accent"
            size="editorial"
            onClick={onRecheck}
            disabled={busy}
            className="h-auto px-3 py-1 text-[11px] uppercase tracking-wider text-text-primary bg-accent/10 hover:bg-accent/20"
          >
            {busy ? "Activating…" : "Re-check"}
          </Button>
        </div>
      )}

      {state.kind === "loading" && (
        <p className="mt-2 text-xs text-text-muted">Checking…</p>
      )}
    </div>
  );
}
