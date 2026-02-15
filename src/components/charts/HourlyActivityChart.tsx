import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { HourlyActivity } from "@/lib/api";

const ACCENT = "#22d3ee";
const SURFACE = "#111827";
const TEXT_MUTED = "#475569";

interface Props {
  data: HourlyActivity[];
  height?: number;
}

export function HourlyActivityChart({ data, height }: Props) {
  // Auto-trim: only show hours from first activity to current hour (or last activity + 1)
  const now = new Date();
  const currentHour = now.getHours();

  const activeHours = data.filter((d) => d.screenshot_count > 0).map((d) => d.hour);
  const minHour = activeHours.length > 0 ? Math.min(...activeHours) : 0;
  const maxHour = activeHours.length > 0
    ? Math.max(Math.max(...activeHours) + 1, currentHour + 1)
    : 24;

  // Align to even boundaries for clean labels
  const startHour = Math.max(0, minHour - (minHour % 2));
  const endHour = Math.min(24, maxHour + (maxHour % 2));

  const full = Array.from({ length: endHour - startHour }, (_, i) => {
    const hour = startHour + i;
    const found = data.find((d) => d.hour === hour);
    return {
      hour,
      label: formatHour(hour),
      screenshot_count: found?.screenshot_count ?? 0,
    };
  });

  const maxCount = Math.max(...full.map((d) => d.screenshot_count), 1);

  if (data.length === 0) {
    return (
      <p className="text-text-muted text-sm text-center py-8">
        No hourly activity data available
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height ?? "100%"}>
      <BarChart
        data={full}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
      >
        <XAxis
          dataKey="label"
          tick={{ fill: TEXT_MUTED, fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          interval={2}
        />
        <YAxis
          tick={{ fill: TEXT_MUTED, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: SURFACE,
            border: "1px solid #1e293b",
            borderRadius: 6,
            fontSize: 12,
          }}
          labelStyle={{ color: "#e2e8f0" }}
          itemStyle={{ color: "#e2e8f0" }}
          formatter={((value: any) => [`${value ?? 0} captures`, "Activity"]) as any}
          cursor={{ fill: "rgba(34, 211, 238, 0.06)" }}
        />
        <Bar dataKey="screenshot_count" radius={[3, 3, 0, 0]} barSize={14}>
          {full.map((entry, index) => (
            <Cell
              key={index}
              fill={ACCENT}
              fillOpacity={
                entry.screenshot_count === 0
                  ? 0.08
                  : 0.3 + 0.7 * (entry.screenshot_count / maxCount)
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}
