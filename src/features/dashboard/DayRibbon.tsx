import { useRef, useState } from "react";
import { Rise } from "@/components/motion";
import { getAppColor } from "@/lib/app-colors";
import type { AppSpan } from "./dashboard-utils";

function fmtClock(secs: number): string {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The day, end to end — every app session as a colored block on one strip,
 * with an accent playhead that follows the cursor. Click to open that moment.
 */
export function DayRibbon({
  spans,
  onPickMoment,
}: {
  spans: AppSpan[];
  onPickMoment?: (timestamp: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  if (spans.length === 0) return null;
  const d0 = spans[0].startTime;
  const d1 = Math.max(Math.floor(Date.now() / 1000), spans[spans.length - 1].endTime);
  const range = Math.max(1, d1 - d0);
  const atX = (x: number) => d0 + x * range;

  const onMove = (e: React.MouseEvent) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setHoverX(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };

  // Mono axis: five evenly spaced clock ticks, ending on "now"
  const ticks = [0, 0.25, 0.5, 0.75].map((p) => fmtClock(atX(p)));

  return (
    <div>
      <div
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverX(null)}
        onClick={() => {
          if (hoverX != null && onPickMoment) onPickMoment(Math.floor(atX(hoverX)));
        }}
        className="relative h-[46px] cursor-crosshair"
      >
        <div
          className="absolute inset-0 rounded-lg overflow-hidden border border-line-2"
          style={{ background: "#100c07" }}
        >
          {spans.map((s, i) => (
            <Rise
              key={`${s.startTime}-${i}`}
              kind="seg"
              i={Math.min(i, 24)}
              start={320}
              step={45}
              title={s.appName}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${((s.startTime - d0) / range) * 100}%`,
                width: `${Math.max(0.15, ((s.endTime - s.startTime) / range) * 100)}%`,
                background: getAppColor(s.appName),
              }}
            >
              <div
                className="absolute inset-0"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(255,255,255,0.18), transparent 40%, rgba(0,0,0,0.28))",
                }}
              />
            </Rise>
          ))}
        </div>
        {/* Playhead — sits at "now", follows the cursor on hover */}
        <div
          className="absolute -top-[5px] -bottom-[5px] w-[1.5px] bg-accent"
          style={{
            left: hoverX != null ? `${hoverX * 100}%` : "100%",
            transition: hoverX != null ? "none" : "left .4s ease",
            boxShadow: "0 0 10px 1px var(--color-accent-line)",
          }}
        >
          <div className="absolute -top-1 -left-[3.25px] size-2 rounded-full bg-accent" />
          {hoverX != null && (
            <div className="absolute -top-[22px] left-1/2 -translate-x-1/2 font-mono text-[10.5px] text-accent-hi whitespace-nowrap">
              {fmtClock(atX(hoverX))}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between mt-3 font-mono text-[10px] text-text-faint">
        {ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
        <span>now</span>
      </div>
    </div>
  );
}
