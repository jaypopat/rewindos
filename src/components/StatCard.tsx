import { Sparkline } from "./Sparkline";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

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

const baseClass = "bg-panel/50 rounded-lg border border-line p-4 flex flex-col gap-2 h-full";

export function StatCard({ label, value, sparklineData, detail, accentColor, trend, trendLabel, onClick }: StatCardProps) {
  const content = (
    <>
      <span className="kicker">{label}</span>
      <div className="flex items-end justify-between gap-3">
        <div>
          <span className="num text-3xl text-text-primary leading-none">{value}</span>
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
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`${baseClass} cursor-pointer hover:border-accent-line transition-colors text-left`}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return <div className={baseClass}>{content}</div>;
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
    <p className={`text-xs mt-1 flex items-center gap-1 ${isUp ? "text-signal-active" : "text-signal-error"}`}>
      {isUp ? (
        <ArrowUpRight className="size-3" strokeWidth={2.5} />
      ) : (
        <ArrowDownRight className="size-3" strokeWidth={2.5} />
      )}
      <span>{Math.abs(trend)}%{label ? ` ${label}` : ""}</span>
    </p>
  );
}
