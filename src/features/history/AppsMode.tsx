import { useState } from "react";
import { formatDuration, formatNumber, formatSecs } from "@/lib/format";
import { getAppColor } from "@/lib/app-colors";
import { StatCard } from "@/components/StatCard";
import { AppDot } from "@/components/AppDot";
import { AppDonutChart } from "@/components/charts/AppDonutChart";
import { ScreenTimeChart } from "@/components/charts/ScreenTimeChart";
import { ChartCard } from "@/components/shared/ChartCard";
import { DailyDigestCard } from "./DailyDigestCard";
import { ChevronDown } from "lucide-react";
import type { ActivityResponse, ActiveBlock } from "@/lib/api";
import type { AppTaskGroup } from "./history-utils";

interface AppsModeProps {
  activity: ActivityResponse;
  totalActiveTime: number;
  activeBlocks: ActiveBlock[];
  totalCaptures: number;
  uniqueApps: number;
  topAppNames: string;
  avgDaily: number;
  rangeDays: number;
  totalScreenTime: number;
  appGroups: AppTaskGroup[];
  chartBlocks: ActiveBlock[];
  start: number;
  end: number;
  digestDay: {
    dateKey: string;
    start: number;
    end: number;
    isToday: boolean;
  } | null;
  onSwitchToTimeline: () => void;
}

export function AppsMode({
  activity,
  totalActiveTime,
  activeBlocks,
  totalCaptures,
  uniqueApps,
  topAppNames,
  avgDaily,
  rangeDays,
  totalScreenTime,
  appGroups,
  chartBlocks,
  start,
  end,
  digestDay,
  onSwitchToTimeline,
}: AppsModeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (app: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 space-y-4">
      {/* Stats */}
      <div className={`grid gap-3 ${rangeDays > 1 ? "grid-cols-2 xl:grid-cols-4" : "grid-cols-3"}`}>
        <StatCard
          label="Screen Time"
          value={formatDuration(totalActiveTime)}
          detail={`${activeBlocks.length} active blocks`}
          accentColor="#22d3ee"
        />
        <StatCard
          label="Captures"
          value={formatNumber(totalCaptures)}
          detail="View in timeline \u2192"
          accentColor="#a78bfa"
          onClick={onSwitchToTimeline}
        />
        <StatCard
          label="Active Apps"
          value={uniqueApps}
          detail={topAppNames}
          accentColor="#34d399"
        />
        {rangeDays > 1 && (
          <StatCard
            label="Avg Daily"
            value={formatDuration(avgDaily)}
            detail={`over ${rangeDays} day${rangeDays > 1 ? "s" : ""}`}
            accentColor="#fb923c"
          />
        )}
      </div>

      {/* Daily Digest -- single-day only */}
      {digestDay && (
        <DailyDigestCard
          dateKey={digestDay.dateKey}
          startTime={digestDay.start}
          endTime={digestDay.end}
          isToday={digestDay.isToday}
          defaultExpanded={false}
        />
      )}

      {/* Charts row -- compact */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChartCard title="Screen Time" compact>
          <ScreenTimeChart
            blocks={(end - start) <= 86400 ? chartBlocks : activeBlocks}
            selectedStart={start}
            selectedEnd={end}
          />
        </ChartCard>
        <ChartCard title="App Distribution" compact>
          <AppDonutChart data={activity.app_usage} />
        </ChartCard>
      </div>

      {/* Task Breakdown (fills remaining space) */}
      {appGroups.length > 0 && (
        <section className="flex-1 flex flex-col min-h-0">
          <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
            Task Breakdown
          </h2>
          <div className="border border-border/50 divide-y divide-border/30 flex-1 overflow-y-auto">
            {appGroups.map((group) => {
              const isOpen = expanded.has(group.appName);
              const pct = totalScreenTime > 0 ? (group.totalSeconds / totalScreenTime) * 100 : 0;
              return (
                <div key={group.appName}>
                  <button
                    onClick={() => toggle(group.appName)}
                    className="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-raised/40 transition-colors text-left"
                  >
                    <AppDot appName={group.appName} size={8} />
                    <span className="text-sm text-text-primary flex-1 truncate">
                      {group.appName}
                    </span>
                    <span className="text-xs text-text-muted font-mono tabular-nums shrink-0 w-12 text-right">
                      {formatSecs(group.totalSeconds)}
                    </span>
                    <div className="w-20 h-1.5 bg-surface-raised rounded-full shrink-0 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: getAppColor(group.appName),
                          opacity: 0.8,
                        }}
                      />
                    </div>
                    <ChevronDown className={`size-3.5 transition-transform shrink-0 ${group.titles.length > 0 ? "text-text-muted" : "text-transparent"} ${isOpen ? "rotate-180" : ""}`} strokeWidth={2} />
                  </button>
                  {isOpen && group.titles.length > 0 && (
                    <div className="bg-surface-raised/20 px-4 pb-2">
                      {group.titles.map((t) => (
                        <div
                          key={t.title}
                          className="flex items-center gap-3 py-1.5 pl-5"
                        >
                          <span className="w-1 h-1 rounded-full bg-text-muted/40 shrink-0" />
                          <span className="text-xs text-text-secondary flex-1 truncate">
                            {t.title}
                          </span>
                          <span className="text-[11px] text-text-muted font-mono tabular-nums shrink-0">
                            {formatSecs(t.seconds)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
