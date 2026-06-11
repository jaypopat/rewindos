import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { Button } from "@/components/ui/button";
import type { View } from "@/components/Sidebar";
import { TOUR_STOPS } from "./tour-stops";
import { useTour } from "./TourContext";

const ANCHOR_TIMEOUT_MS = 1500;
const SPOTLIGHT_PAD = 6;
const DIM = "rgba(8, 6, 3, 0.72)";

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TourOverlay({ onNavigate }: { onNavigate: (v: View) => void }) {
  const { active, stepIndex, next, back, end } = useTour();
  if (!active) return null;
  return (
    // key resets per-step state (anchor polling, rect) on every step change
    <TourStep
      key={stepIndex}
      stepIndex={stepIndex}
      onNavigate={onNavigate}
      next={next}
      back={back}
      end={end}
    />
  );
}

function TourStep({
  stepIndex,
  onNavigate,
  next,
  back,
  end,
}: {
  stepIndex: number;
  onNavigate: (v: View) => void;
  next: () => void;
  back: () => void;
  end: () => void;
}) {
  const stop = TOUR_STOPS[stepIndex];
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  // Each stop opens its view.
  useEffect(() => {
    onNavigate(stop.view);
  }, [stop.view, onNavigate]);

  // Poll for the anchor until it mounts; the tour never blocks on a missing
  // anchor — after the timeout the card renders centered with no spotlight.
  useEffect(() => {
    let raf = 0;
    const deadline = performance.now() + ANCHOR_TIMEOUT_MS;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${stop.anchor}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        return;
      }
      if (performance.now() > deadline) {
        setTimedOut(true);
        return;
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [stop.anchor]);

  // Track the anchor while visible (resize, layout shifts).
  useEffect(() => {
    if (rect == null) return;
    const remeasure = () => {
      const el = document.querySelector(`[data-tour="${stop.anchor}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    };
    window.addEventListener("resize", remeasure);
    return () => window.removeEventListener("resize", remeasure);
  }, [rect == null, stop.anchor]);

  const { refs, floatingStyles } = useFloating({
    placement: "bottom",
    middleware: [offset(14), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    if (rect == null) return;
    refs.setPositionReference({
      getBoundingClientRect: () =>
        ({
          x: rect.left,
          y: rect.top,
          top: rect.top,
          left: rect.left,
          bottom: rect.top + rect.height,
          right: rect.left + rect.width,
          width: rect.width,
          height: rect.height,
        }) as DOMRect,
    });
  }, [rect, refs]);

  // Esc ends — same overlay convention as ConfirmDialog/JournalSearchPanel.
  useHotkey("Escape", () => end());

  const isLast = stepIndex === TOUR_STOPS.length - 1;
  const spotlight = rect != null && !timedOut;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="Feature tour">
      {spotlight ? (
        <div
          className="absolute rounded-lg"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: `0 0 0 9999px ${DIM}`,
          }}
        />
      ) : (
        <div className="absolute inset-0" style={{ background: DIM }} />
      )}

      <div
        ref={refs.setFloating}
        style={spotlight ? floatingStyles : undefined}
        className={
          spotlight
            ? "w-[340px]"
            : "absolute left-1/2 top-1/2 w-[340px] -translate-x-1/2 -translate-y-1/2"
        }
      >
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-surface p-5 shadow-2xl">
          <h3 className="text-sm font-semibold text-text-primary">{stop.title}</h3>
          <p className="text-[12.5px] leading-relaxed text-text-secondary">{stop.body}</p>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5" aria-hidden>
              {TOUR_STOPS.map((s, i) => (
                <span
                  key={s.id}
                  className={`size-1.5 rounded-full ${i === stepIndex ? "bg-accent" : "bg-border/60"}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="editorial-muted"
                size="editorial"
                onClick={end}
                className="border-0 px-0 hover:bg-transparent hover:text-text-primary"
              >
                End tour
              </Button>
              <Button variant="ghost" size="sm" onClick={back} disabled={stepIndex === 0}>
                Back
              </Button>
              <Button size="sm" onClick={next}>
                {isLast ? "Finish" : "Next"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
