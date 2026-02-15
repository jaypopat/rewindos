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
            <button
              onClick={() => queryClient.invalidateQueries({ queryKey: queryKeys.daemonStatus() })}
              className="flex items-center gap-2 text-xs font-mono text-signal-error/80 hover:text-signal-error transition-colors"
            >
              <span className="h-2 w-2 bg-signal-error" />
              daemon offline
              <RefreshCw className="size-3 text-text-muted" strokeWidth={2} />
            </button>
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

  const isCapturing = status.is_capturing;

  return (
    <TooltipProvider>
      <div className="flex items-center gap-3 text-xs font-mono">
        {/* Capture toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleToggle}
              disabled={isToggling}
              className="flex items-center gap-1.5 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <span className="relative flex h-2 w-2">
                {isCapturing && (
                  <span className="absolute inline-flex h-full w-full animate-ping bg-signal-active opacity-75" />
                )}
                <span className={`relative inline-flex h-2 w-2 ${isCapturing ? "bg-signal-active" : "bg-signal-paused"}`} />
              </span>
              {isCapturing ? "capturing" : "paused"}
            </button>
          </TooltipTrigger>
          <TooltipContent>{isCapturing ? "Click to pause" : "Click to resume"}</TooltipContent>
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
