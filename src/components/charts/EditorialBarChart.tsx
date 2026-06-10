import { useState } from "react";

export interface BarPoint {
  label: string;
  value: number;
}

/**
 * Editorial bar chart — vertical bars with rounded caps, accent gradient fill,
 * intensity-mapped opacity, hover tooltip, and hairline gridlines. Designed to
 * replace the area chart for "Captures per hour" where discrete buckets read
 * better than a continuous curve.
 */
export function EditorialBarChart({
  data,
  width = 720,
  height = 200,
  tickEvery = 4,
}: {
  data: BarPoint[];
  width?: number;
  height?: number;
  tickEvery?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length < 2) return null;

  const pad = { l: 4, r: 4, t: 16, b: 24 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const vals = data.map((d) => d.value);
  const max = Math.max(...vals) || 1;
  const peakIdx = vals.indexOf(Math.max(...vals));

  const barGap = 0.25; // fraction of slot reserved as gap
  const slotW = iw / data.length;
  const barW = slotW * (1 - barGap);
  const radius = Math.min(barW / 2, 3);

  const barX = (i: number) => pad.l + i * slotW + (slotW - barW) / 2;
  const barH = (v: number) => (v / max) * ih;
  const barY = (v: number) => pad.t + ih - barH(v);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="editorial-bar-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-hi)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.7" />
          </linearGradient>
        </defs>
        {/* Gridlines */}
        {[0, 0.5, 1].map((g) => (
          <line
            key={g}
            x1={pad.l}
            x2={width - pad.r}
            y1={pad.t + ih - g * ih}
            y2={pad.t + ih - g * ih}
            stroke="var(--color-line)"
          />
        ))}
        {/* Bars */}
        {data.map((d, i) => {
          const h = barH(d.value);
          const isPeak = i === peakIdx && d.value > 0;
          const isHovered = hover === i;
          const baseOpacity = d.value === 0 ? 0.06 : 0.35 + 0.65 * (d.value / max);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              {/* Invisible hit area for hover */}
              <rect
                x={pad.l + i * slotW}
                y={pad.t}
                width={slotW}
                height={ih + pad.b}
                fill="transparent"
              />
              {/* The bar */}
              <rect
                x={barX(i)}
                y={barY(d.value)}
                width={barW}
                height={Math.max(h, d.value > 0 ? 1.5 : 0)}
                rx={radius}
                ry={radius}
                fill={isPeak || isHovered ? "url(#editorial-bar-fill)" : "var(--color-accent)"}
                opacity={isHovered ? 1 : baseOpacity}
                style={{
                  transition: "opacity .15s ease, y .4s cubic-bezier(.22,.61,.36,1), height .4s cubic-bezier(.22,.61,.36,1)",
                }}
              />
              {/* Hover guide line */}
              {isHovered && (
                <line
                  x1={barX(i) + barW / 2}
                  x2={barX(i) + barW / 2}
                  y1={pad.t}
                  y2={pad.t + ih}
                  stroke="var(--color-line-hi)"
                  strokeDasharray="2 2"
                  opacity="0.4"
                />
              )}
              {/* Peak dot */}
              {isPeak && (
                <circle
                  cx={barX(i) + barW / 2}
                  cy={barY(d.value) - 5}
                  r="2.2"
                  fill="var(--color-accent-hi)"
                />
              )}
              {/* X-axis labels — text-muted, not faint: ticks must survive the
                  near-black background. End labels anchor inward to avoid clipping. */}
              {i % tickEvery === 0 && (
                <text
                  x={barX(i) + barW / 2}
                  y={height - 7}
                  textAnchor={i === 0 ? "start" : i >= data.length - tickEvery ? "end" : "middle"}
                  fontFamily="var(--font-mono)"
                  fontSize="10"
                  fill="var(--color-text-muted)"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Tooltip */}
      {hover != null && (
        <div
          className="absolute pointer-events-none whitespace-nowrap rounded-[7px] border border-line-hi bg-surface-raised px-2.5 py-[7px]"
          style={{
            left: `${((barX(hover) + barW / 2) / width) * 100}%`,
            top: 4,
            transform: "translate(-50%,-100%)",
            boxShadow: "0 16px 40px -16px #000",
          }}
        >
          <div className="font-mono text-[10.5px] text-text-muted">{data[hover].label}</div>
          <div className="num text-base">{vals[hover]} captures</div>
        </div>
      )}
    </div>
  );
}
