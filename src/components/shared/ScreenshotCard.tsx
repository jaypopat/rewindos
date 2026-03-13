import { getImageUrl } from "@/lib/api";
import { AppDot } from "@/components/AppDot";
import { formatRelativeTime } from "@/lib/format";
import { ImageIcon } from "lucide-react";

interface ScreenshotCardProps {
  screenshot: {
    id: number;
    thumbnail_path: string | null;
    app_name: string | null;
    window_title: string | null;
    timestamp: number;
  };
  onClick?: () => void;
  actions?: React.ReactNode;
}

export function ScreenshotCard({ screenshot, onClick, actions }: ScreenshotCardProps) {
  return (
    <div className="group relative overflow-hidden bg-surface-raised border border-border/30 hover:border-accent/30 transition-all cursor-pointer text-left">
      <button onClick={onClick} className="w-full">
        <div className="aspect-video bg-surface-overlay relative">
          {screenshot.thumbnail_path ? (
            <img
              src={getImageUrl(screenshot.thumbnail_path)}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-text-muted">
              <ImageIcon className="size-8 opacity-30" strokeWidth={1} />
            </div>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-surface/95 via-surface/70 to-transparent p-3 pt-8">
          <div className="flex items-center gap-1.5 mb-1">
            {screenshot.app_name && (
              <>
                <AppDot appName={screenshot.app_name} size={6} />
                <span className="text-[10px] font-mono text-text-secondary truncate">
                  {screenshot.app_name}
                </span>
              </>
            )}
            <span className="text-[10px] text-text-muted ml-auto shrink-0">
              {formatRelativeTime(screenshot.timestamp)}
            </span>
          </div>
          {screenshot.window_title && (
            <p className="text-xs text-text-primary truncate leading-tight">
              {screenshot.window_title}
            </p>
          )}
        </div>
      </button>
      {actions && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
}
