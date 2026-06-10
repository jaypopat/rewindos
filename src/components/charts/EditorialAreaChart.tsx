import { useState } from "react";

export interface AreaPoint {
  label: string;
  value: number;
}

/**
 * Editorial line/area chart — hairline gridlines, one accent bezier line with a
 * soft gradient fill, a dot on the peak, hover guide + tooltip. The quiet
 * replacement for bar charts on the Briefing home.
 */
export function EditorialAreaChart({
  data,
  width = 720,
  height = 200,
  tickEvery = 4,
}: {
  data: AreaPoint[];
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
  const xs = (i: number) => pad.l + (i / (data.length - 1)) * iw;
  const ys = (v: number) => pad.t + ih - (v / max) * ih;
  const pts = vals.map((v, i) => [xs(i), ys(v)] as const);

  const line = pts
    .map((p, i) => {
      if (i === 0) return `M${p[0]},${p[1]}`;
      const pr = pts[i - 1];
      const cx = (pr[0] + p[0]) / 2;
      return `C${cx},${pr[1]} ${cx},${p[1]} ${p[0]},${p[1]}`;
    })
    .join(" ");
  const area = `${line} L${pts[pts.length - 1][0]},${pad.t + ih} L${pts[0][0]},${pad.t + ih} Z`;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="editorial-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
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
        <path d={area} fill="url(#editorial-area-fill)" />
        <path d={line} fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
        <circle cx={pts[peakIdx][0]} cy={pts[peakIdx][1]} r="3" fill="var(--color-accent-hi)" />
        {data.map((d, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect
              x={xs(i) - iw / data.length / 2}
              y={pad.t}
              width={iw / data.length}
              height={ih}
              fill="transparent"
            />
            {hover === i && (
              <>
                <line
                  x1={pts[i][0]}
                  x2={pts[i][0]}
                  y1={pad.t}
                  y2={pad.t + ih}
                  stroke="var(--color-line-hi)"
                />
                <circle cx={pts[i][0]} cy={pts[i][1]} r="3.2" fill="var(--color-accent-hi)" />
              </>
            )}
            {i % tickEvery === 0 && (
              <text
                x={pts[i][0]}
                y={height - 7}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize="10"
                fill="var(--color-text-faint)"
              >
                {d.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {hover != null && (
        <div
          className="absolute pointer-events-none whitespace-nowrap rounded-[7px] border border-line-hi bg-surface-raised px-2.5 py-[7px]"
          style={{
            left: `${(pts[hover][0] / width) * 100}%`,
            top: 4,
            transform: "translate(-50%,-100%)",
            boxShadow: "0 16px 40px -16px #000",
          }}
        >
          <div className="font-mono text-[10.5px] text-text-muted">{data[hover].label}</div>
          <div className="num text-base">{vals[hover]}</div>
        </div>
      )}
    </div>
  );
}
