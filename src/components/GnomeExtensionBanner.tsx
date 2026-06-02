import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getDaemonStatus, openExtensionPage } from "@/lib/api";

const DISMISS_KEY = "gnome-extension-banner-dismissed";

export function GnomeExtensionBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
    getDaemonStatus()
      .then((s) => {
        const isGnome = (s.desktop ?? "").toLowerCase().includes("gnome");
        const provider = s.window_info_provider ?? "";
        const tracking = provider !== "" && provider !== "noop";
        setShow(isGnome && !tracking);
      })
      .catch(() => setShow(false));
  }, []);

  if (!show) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-text-primary">
      <span className="flex-1">
        App and window tracking is off on GNOME. Install the "Window Calls
        Extended" extension to enable it.
      </span>
      <button
        onClick={() => void openExtensionPage()}
        className="px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider bg-accent/10 border border-accent/30 hover:bg-accent/20 transition-all"
      >
        Install
      </button>
      <button
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setShow(false);
        }}
        className="text-text-muted hover:text-text-primary transition-colors"
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
