import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useScrubber } from "./useScrubber";
import type { TimelineEntry } from "@/lib/api";

type Sel = { startIdx: number; endIdx: number } | null;

function setup(initialSelection: Sel) {
  let selection: Sel = initialSelection;
  const setRangeSelection = vi.fn(
    (update: Sel | ((prev: Sel) => Sel)) => {
      selection = typeof update === "function" ? update(selection) : update;
    },
  );
  // 11 screenshots, 10s apart, spanning 1000..1100
  const screenshots: TimelineEntry[] = Array.from({ length: 11 }, (_, i) => ({
    id: i + 1,
    timestamp: 1000 + i * 10,
    app_name: null,
    window_title: null,
    thumbnail_path: null,
    file_path: `/s/${i}.webp`,
  }));
  const { result } = renderHook(() =>
    useScrubber(
      screenshots,
      1000,
      1100,
      0,
      vi.fn(),
      /* rangeMode */ true,
      selection,
      setRangeSelection,
    ),
  );
  // The hook reads track geometry from trackRef; give it a fake element.
  const track = document.createElement("div");
  track.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 100,
      height: 10,
      right: 100,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  (
    result.current.trackRef as React.MutableRefObject<HTMLDivElement | null>
  ).current = track;
  return { result, getSelection: () => selection };
}

describe("useScrubber range drag", () => {
  it("extends endIdx during a drag that started with no selection", () => {
    const { result, getSelection } = setup(null);

    act(() => {
      result.current.handleTrackMouseDown({
        clientX: 0,
        preventDefault: () => {},
      } as unknown as React.MouseEvent);
    });
    expect(getSelection()).toEqual({ startIdx: 0, endIdx: 0 });

    // Drag to the middle of the track: 50/100 → ts 1050 → index 5.
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: 50 }));
    });
    expect(getSelection()?.endIdx).toBe(5);

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 50 }));
    });
  });
});
