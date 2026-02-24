import { formatSecs } from "@/lib/format";
import { AppDot } from "@/components/AppDot";
import { getAppColor } from "@/lib/app-colors";
import type { TopTask } from "./dashboard-utils";

interface TopTasksListProps {
  tasks: TopTask[];
  totalScreenTime: number;
}

export function TopTasksList({ tasks, totalScreenTime }: TopTasksListProps) {
  return (
    <section className="flex flex-col min-h-0">
      <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em] mb-2">
        Top Tasks
      </h2>
      <div className="border border-border/50 divide-y divide-border/30 flex-1">
        {tasks.map((task) => {
          const pct = totalScreenTime > 0 ? (task.totalSeconds / totalScreenTime) * 100 : 0;
          return (
            <div key={task.appName} className="flex items-center gap-3 px-4 py-2.5">
              <AppDot appName={task.appName} size={8} />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-text-primary">{task.appName}</span>
                {task.topTitle && (
                  <span className="text-xs text-text-muted ml-2 truncate">
                    {task.topTitle}
                  </span>
                )}
              </div>
              <span className="text-xs text-text-muted font-mono tabular-nums shrink-0">
                {formatSecs(task.totalSeconds)}
              </span>
              <div className="w-20 h-1.5 bg-surface-raised rounded-full shrink-0 overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: getAppColor(task.appName),
                    opacity: 0.8,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
