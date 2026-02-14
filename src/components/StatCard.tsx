import { Sparkline } from "./Sparkline";

interface StatCardProps {
  label: string;
  value: string | number;
  sparklineData?: number[];
  detail?: string;
  accentColor?: string;
  trend?: number;
  trendLabel?: string;
  onClick?: () => void;
}

export function StatCard({ label, value, sparklineData, detail, accentColor, trend, trendLabel, onClick }: StatCardProps) {
  return (
    <div
      className={`bg-surface-raised rounded-xl border border-border/50 p-4 flex flex-col gap-2${onClick ? " cursor-pointer hover:border-accent/30 transition-colors" : ""}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className="font-display text-2xl text-text-primary leading-none">{value}</span>
          {trend !== undefined ? (
            <TrendIndicator trend={trend} label={trendLabel} />
          ) : (
            detail && <p className="text-xs text-text-muted mt-1">{detail}</p>
          )}
        </div>
        {sparklineData && sparklineData.length >= 2 && (
          <Sparkline data={sparklineData} color={accentColor} />
        )}
      </div>
    </div>
  );
}

function TrendIndicator({ trend, label }: { trend: number; label?: string }) {
  if (trend === 0) {
    return (
      <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
        <span className="text-text-muted">=</span>
        <span>flat{label ? ` ${label}` : ""}</span>
      </p>
    );
  }
  const isUp = trend > 0;
  return (
    <p className={`text-xs mt-1 flex items-center gap-1 ${isUp ? "text-emerald-400" : "text-red-400"}`}>
      <svg className="size-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
        {isUp ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 4.5l15 15m0 0V8.25m0 11.25H8.25" />
        )}
      </svg>
      <span>{Math.abs(trend)}%{label ? ` ${label}` : ""}</span>
    </p>
  );
}
