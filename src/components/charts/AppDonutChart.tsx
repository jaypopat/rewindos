import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import type { AppUsageStat } from "@/lib/api";
import { getAppColor } from "@/lib/app-colors";
import { AppDot } from "@/components/AppDot";

const SURFACE = "#111827";

interface Props {
  data: AppUsageStat[];
}

export function AppDonutChart({ data }: Props) {
  // Filter out entries with < 1% to reduce noise in legend
  const meaningful = data.filter((d) => d.percentage >= 1);
  const top8 = (meaningful.length > 0 ? meaningful : data).slice(0, 8);
  const total = data.reduce((sum, d) => sum + d.screenshot_count, 0);

  if (top8.length === 0) {
    return (
      <p className="text-text-muted text-sm text-center py-8">
        No app usage data available
      </p>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative w-44 h-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={top8}
              dataKey="screenshot_count"
              nameKey="app_name"
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={72}
              strokeWidth={2}
              stroke="#0a0e1a"
            >
              {top8.map((entry) => (
                <Cell key={entry.app_name} fill={getAppColor(entry.app_name)} fillOpacity={0.85} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: SURFACE,
                border: "1px solid #1e293b",
                borderRadius: 6,
                color: "#e2e8f0",
                fontSize: 12,
              }}
              itemStyle={{ color: "#e2e8f0" }}
              labelStyle={{ color: "#94a3b8" }}
              formatter={((value: any, name: any) => [`${value ?? 0} captures (${(((value ?? 0) / total) * 100).toFixed(1)}%)`, name]) as any}
            />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="font-display text-xl text-text-primary leading-none">{total}</span>
          <span className="text-[10px] text-text-muted mt-0.5">total</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex-1 space-y-1.5 min-w-0">
        {top8.map((entry) => (
          <div key={entry.app_name} className="flex items-center gap-2 text-xs">
            <AppDot appName={entry.app_name} size={6} />
            <span className="text-text-secondary truncate flex-1">{entry.app_name}</span>
            <span className="text-text-muted font-mono tabular-nums shrink-0">
              {entry.percentage.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
