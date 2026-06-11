import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getDaemonStatus, openExtensionPage, setUnfilteredCapture } from "@/lib/api";
import { Button } from "@/components/ui/button";

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
      <Button
        variant="editorial-accent"
        size="editorial"
        onClick={() => void openExtensionPage()}
        className="px-2 py-0.5 text-[11px] uppercase tracking-wider bg-accent/10 hover:bg-accent/20"
      >
        Install
      </Button>
      <Button
        variant="editorial-muted"
        size="editorial"
        onClick={async () => {
          await setUnfilteredCapture(true);
          setShow(false);
        }}
        className="px-2 py-0.5 text-[11px] uppercase tracking-wider text-text-muted border border-border/60 hover:bg-surface"
        title="Capture without enforcing app/incognito exclusions"
      >
        Capture anyway
      </Button>
      <Button
        variant="quiet"
        size="icon-xs"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setShow(false);
        }}
        className="hover:text-text-primary"
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
