import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getDaemonStatus, pauseCapture, resumeCapture } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { formatDuration, formatBytes } from "@/lib/format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DaemonPanel() {
  const queryClient = useQueryClient();

  const { data: status, isError } = useQuery({
    queryKey: queryKeys.daemonStatus(),
    queryFn: getDaemonStatus,
    refetchInterval: 5000,
    retry: false,
  });

  const pauseMutation = useMutation({
    mutationFn: pauseCapture,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.daemonStatus() }),
  });

  const resumeMutation = useMutation({
    mutationFn: resumeCapture,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.daemonStatus() }),
  });

  const isToggling = pauseMutation.isPending || resumeMutation.isPending;

  const handleToggle = () => {
    if (isToggling) return;
    if (status?.is_capturing) {
      pauseMutation.mutate();
    } else {
      resumeMutation.mutate();
    }
  };

  if (isError) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.daemonStatus() })}
              className="h-auto p-0 flex items-center gap-2 text-xs font-mono text-signal-error/80 hover:text-signal-error hover:bg-transparent"
            >
              <span className="h-2 w-2 bg-signal-error" />
              daemon offline
              <RefreshCw className="size-3 text-text-muted" strokeWidth={2} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1 text-xs">
              <p className="font-medium">Daemon not running</p>
              <p className="text-text-muted">Run: cargo run -p rewindos-daemon</p>
              <p className="text-text-muted">Click to retry connection</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-xs font-mono text-text-muted">
        <span className="h-2 w-2 bg-surface-overlay animate-pulse" />
        connecting...
      </div>
    );
  }

  const isCapturing = status.is_capturing; // user intent — drives the toggle action

  // Display reflects EFFECTIVE state (capture_state), which may differ from intent
  // (e.g. auto-paused while locked, or stalled). Falls back to intent for old daemons.
  const captureState = status.capture_state
    ?? (isCapturing ? "capturing" : "paused_user");

  const display = {
    capturing:      { color: "bg-signal-active",  label: "capturing", ping: true },
    stalled:        { color: "bg-signal-stalled", label: "stalled",   ping: false },
    paused_user:    { color: "bg-signal-paused",  label: "paused",    ping: false },
    paused_locked:  { color: "bg-signal-paused",  label: "paused — locked",  ping: false },
    paused_privacy: { color: "bg-signal-paused",  label: "paused — privacy", ping: false },
  }[captureState] ?? { color: "bg-signal-paused", label: captureState, ping: false };

  const toggleHint = isCapturing ? "Click to pause" : "Click to resume";
  const reasonHint =
    captureState === "paused_locked" ? " (screen locked)" :
    captureState === "paused_privacy" ? " (exclusions can't be enforced)" :
    captureState === "stalled" ? " (no frames arriving)" : "";

  return (
    <TooltipProvider>
      <div className="flex items-center gap-3 text-xs font-mono">
        {/* Capture toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              onClick={handleToggle}
              disabled={isToggling}
              className="h-auto p-0 flex items-center gap-1.5 text-text-secondary hover:text-text-primary hover:bg-transparent"
            >
              <span className="relative flex h-2 w-2">
                {display.ping && (
                  <span className="absolute inline-flex h-full w-full animate-ping bg-signal-active opacity-75" />
                )}
                <span className={`relative inline-flex h-2 w-2 ${display.color}`} />
              </span>
              {display.label}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{toggleHint}{reasonHint}</TooltipContent>
        </Tooltip>

        <span className="text-border">|</span>

        {/* Stats */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-text-muted font-mono tabular-nums">
              {status.frames_captured_today} today
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="space-y-1">
              <p>Captured: {status.frames_captured_today}</p>
              <p>Deduplicated: {status.frames_deduplicated_today}</p>
              <p>OCR pending: {status.frames_ocr_pending}</p>
              <p>Uptime: {formatDuration(status.uptime_seconds)}</p>
              <p>Disk: {formatBytes(status.disk_usage_bytes)}</p>
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
