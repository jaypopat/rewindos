import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

const EASE = "cubic-bezier(.22,.61,.36,1)";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Rise — a self-contained staggered entrance element. Each instance owns its
 * timer and inline styles, so parent re-renders (e.g. count-ups) never disturb
 * it, and a remount replays it. kind: "rise" (fade+lift), "draw" (bar wipe-in),
 * "seg" (ribbon segment).
 */
export function Rise({
  i = 0,
  kind = "rise",
  step = 60,
  start = 60,
  style,
  className,
  title,
  onClick,
  children,
}: {
  i?: number;
  kind?: "rise" | "draw" | "seg";
  step?: number;
  start?: number;
  style?: CSSProperties;
  className?: string;
  title?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setOn(true);
      return;
    }
    const t = setTimeout(() => setOn(true), start + i * step);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transition = `opacity .6s ${EASE}, transform .6s ${EASE}`;
  let motion: CSSProperties;
  if (kind === "draw") {
    motion = { transform: on ? "scaleX(1)" : "scaleX(0)", transformOrigin: "left", transition };
  } else if (kind === "seg") {
    motion = {
      opacity: on ? 0.9 : 0,
      transform: on ? "scaleX(1)" : "scaleX(0)",
      transformOrigin: "left",
      transition,
    };
  } else {
    motion = {
      opacity: on ? 1 : 0,
      transform: on ? "none" : "translateY(14px)",
      transition,
    };
  }
  return (
    <div className={className} title={title} onClick={onClick} style={{ ...style, ...motion }}>
      {children}
    </div>
  );
}

/** Count a numeral up from 0 to `target` with a cubic ease-out, always settling exactly on target. */
export function useCountUp(target: number, { dur = 1000 }: { dur?: number } = {}): number {
  const [val, setVal] = useState(target);
  useEffect(() => {
    if (prefersReducedMotion() || target === 0) {
      setVal(target);
      return;
    }
    setVal(0);
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const steps = Math.max(1, Math.round(dur / 40));
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      const p = Math.min(1, n / steps);
      setVal(target * ease(p));
      if (p >= 1) clearInterval(id);
    }, 40);
    return () => clearInterval(id);
  }, [target, dur]);
  return val;
}

/** Serif count-up numeral. */
export function CountNum({
  value,
  format,
  className,
  style,
  dur,
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
  style?: CSSProperties;
  dur?: number;
}) {
  const v = useCountUp(value, { dur });
  const shown = format ? format(v) : Math.round(v).toLocaleString();
  return (
    <span className={className} style={style}>
      {shown}
    </span>
  );
}
