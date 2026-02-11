import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { DailyActivity } from "@/lib/api";
import { formatDateShort } from "@/lib/format";

const ACCENT = "#22d3ee";
const SECONDARY = "#a78bfa";
const SURFACE = "#111827";
const TEXT_MUTED = "#475569";

interface Props {
  data: DailyActivity[];
  height?: number;
}

export function DailyActivityChart({ data, height = 240 }: Props) {
  if (data.length === 0) {
    return (
      <p className="text-text-muted text-sm text-center py-8">
        No daily activity data available
      </p>
    );
  }

  const formatted = data.map((d) => ({
    ...d,
    label: formatDateShort(d.date),
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={formatted}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
      >
        <defs>
          <linearGradient id="cyanGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
            <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="label"
          tick={{ fill: TEXT_MUTED, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="left"
          tick={{ fill: TEXT_MUTED, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          tick={{ fill: TEXT_MUTED, fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          width={30}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: SURFACE,
            border: "1px solid #1e293b",
            borderRadius: 6,
            color: "#e2e8f0",
            fontSize: 12,
          }}
          labelStyle={{ color: "#e2e8f0" }}
          formatter={((value: any, name: any) => [
            value ?? 0,
            name === "screenshot_count" ? "Captures" : "Apps",
          ]) as any}
          labelFormatter={(label) => label}
          cursor={{ stroke: ACCENT, strokeOpacity: 0.3 }}
        />
        <Area
          yAxisId="left"
          type="monotone"
          dataKey="screenshot_count"
          stroke={ACCENT}
          strokeWidth={2}
          fill="url(#cyanGradient)"
        />
        <Line
          yAxisId="right"
          type="monotone"
          dataKey="unique_apps"
          stroke={SECONDARY}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
