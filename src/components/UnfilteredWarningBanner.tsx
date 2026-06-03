import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { getDaemonStatus, setUnfilteredCapture } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

/// Persistent, NON-DISMISSIBLE warning shown whenever capture is running with
/// privacy exclusions unenforced (the user opted into the escape hatch). The
/// only way to clear it is to turn enforcement back on. An override that can
/// hide its own warning is the silent-failure mode wearing a hat.
export function UnfilteredWarningBanner() {
  const { data: status, refetch } = useQuery({
    queryKey: queryKeys.daemonStatus(),
    queryFn: getDaemonStatus,
    refetchInterval: 5000,
  });

  if (!status?.unfiltered_capture) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-signal-error/15 border-b border-signal-error/40 text-xs text-text-primary">
      <AlertTriangle className="size-4 text-signal-error shrink-0" />
      <span className="flex-1">
        Recording <strong>unfiltered</strong> — privacy exclusions (password
        managers, incognito) are not being enforced.
      </span>
      <button
        onClick={async () => {
          await setUnfilteredCapture(false);
          await refetch();
        }}
        className="px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider bg-surface border border-border/60 hover:bg-surface-overlay transition-all"
      >
        Re-enable filtering
      </button>
    </div>
  );
}
