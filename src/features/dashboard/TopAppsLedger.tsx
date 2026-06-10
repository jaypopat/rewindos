import { Rise } from "@/components/motion";
import { getAppColor } from "@/lib/app-colors";
import { formatSecs } from "@/lib/format";
import type { TopTask } from "./dashboard-utils";

/**
 * Top applications as a hairline ledger — name + category tag, a 2px colored
 * usage bar that draws in, mono duration. No rank numbers on Home.
 */
export function TopAppsLedger({
  apps,
  categoryFor,
  totalSeconds,
  riseBase = 0,
  onSelectApp,
}: {
  apps: TopTask[];
  categoryFor: (appName: string) => string;
  /** Total tracked screen seconds — when set, each row shows its share. */
  totalSeconds?: number;
  riseBase?: number;
  onSelectApp?: (appName: string) => void;
}) {
  if (apps.length === 0) return null;
  const max = Math.max(...apps.map((a) => a.totalSeconds));

  return (
    <div className="border-t border-line">
      {apps.map((a, i) => (
        <Rise
          key={a.appName}
          i={riseBase + i}
          className="grid grid-cols-[1fr_auto] items-center gap-4 px-0.5 py-3 border-b border-line hover:bg-panel transition-colors cursor-pointer"
          onClick={() => onSelectApp?.(a.appName)}
        >
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5 whitespace-nowrap min-w-0">
              <b className="font-medium text-sm">{a.appName}</b>
              <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint">
                {categoryFor(a.appName)}
              </span>
              {a.topTitle && (
                <span className="text-xs text-text-muted truncate min-w-0">{a.topTitle}</span>
              )}
            </div>
            <div className="relative h-0.5 bg-line-2 rounded-sm mt-2.5 overflow-hidden">
              <Rise
                kind="draw"
                i={riseBase + i}
                start={260}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: `${(a.totalSeconds / max) * 100}%`,
                  background: getAppColor(a.appName),
                  opacity: 0.6,
                }}
              />
            </div>
          </div>
          <span className="font-mono text-xs text-text-secondary whitespace-nowrap">
            {formatSecs(a.totalSeconds)}
            {totalSeconds && totalSeconds > 0 ? (
              <span className="text-text-faint">
                {" "}
                · {Math.round((a.totalSeconds / totalSeconds) * 100)}%
              </span>
            ) : null}
          </span>
        </Rise>
      ))}
    </div>
  );
}
