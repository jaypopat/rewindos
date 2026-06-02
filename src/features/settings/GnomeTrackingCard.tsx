import { useCallback, useEffect, useState } from "react";
import {
  gnomeExtensionStatus,
  recheckWindowInfo,
  openExtensionPage,
  getDaemonStatus,
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
            <button
              onClick={() => void openExtensionPage()}
              className="px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-text-primary bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-all"
            >
              Install
            </button>
            <button
              onClick={onRecheck}
              disabled={busy}
              className="px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-text-muted border border-border/60 hover:bg-surface transition-all disabled:opacity-50"
            >
              {busy ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
      )}

      {state.kind === "installed-inactive" && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-text-muted">
            Extension detected but not yet active. Click re-check to activate
            tracking without restarting.
          </p>
          <button
            onClick={onRecheck}
            disabled={busy}
            className="px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-text-primary bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-all disabled:opacity-50"
          >
            {busy ? "Activating…" : "Re-check"}
          </button>
        </div>
      )}

      {state.kind === "loading" && (
        <p className="mt-2 text-xs text-text-muted">Checking…</p>
      )}
    </div>
  );
}
