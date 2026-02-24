import { useCallback, useMemo, useRef } from "react";
import { getImageUrl, type TimelineEntry } from "@/lib/api";
import { findNearest, formatTimeShort, formatHourLabel } from "@/features/rewind/rewind-utils";

export function useScrubber(
  screenshots: TimelineEntry[],
  startTime: number,
  endTime: number,
  currentIndex: number,
  setCurrentIndex: (idx: number) => void,
  rangeMode: boolean,
  rangeSelection: { startIdx: number; endIdx: number } | null,
  setRangeSelection: React.Dispatch<
    React.SetStateAction<{ startIdx: number; endIdx: number } | null>
  >,
) {
  // -- Refs -----------------------------------------------------------------
  const isDraggingRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const hoverPreviewRef = useRef<HTMLDivElement>(null);
  const hoverImgRef = useRef<HTMLImageElement>(null);
  const hoverTimeRef = useRef<HTMLSpanElement>(null);

  // -- Position helpers -----------------------------------------------------
  const pixelToTime = useCallback(
    (x: number, trackWidth: number): number => {
      const fraction = Math.max(0, Math.min(1, x / trackWidth));
      return startTime + fraction * (endTime - startTime);
    },
    [startTime, endTime],
  );

  const timeToFraction = useCallback(
    (t: number): number => {
      if (endTime === startTime) return 0;
      return Math.max(0, Math.min(1, (t - startTime) / (endTime - startTime)));
    },
    [startTime, endTime],
  );

  // -- Scrubber visual updates ----------------------------------------------
  const updateScrubVisuals = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || screenshots.length === 0) return;
      const rect = track.getBoundingClientRect();
      const x = clientX - rect.left;
      const ts = pixelToTime(x, rect.width);
      const idx = findNearest(screenshots, ts);
      const fraction = timeToFraction(screenshots[idx].timestamp);

      // Move handle
      if (handleRef.current) {
        handleRef.current.style.left = `${fraction * 100}%`;
      }

      // Update hover preview (used during drag)
      if (hoverImgRef.current && screenshots[idx].thumbnail_path) {
        hoverImgRef.current.src = getImageUrl(screenshots[idx].thumbnail_path!);
      }
      if (hoverTimeRef.current) {
        hoverTimeRef.current.textContent = formatTimeShort(screenshots[idx].timestamp);
      }

      return idx;
    },
    [screenshots, pixelToTime, timeToFraction],
  );

  // -- Mouse handlers -------------------------------------------------------
  const handleTrackMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (screenshots.length === 0) return;
      e.preventDefault();
      isDraggingRef.current = true;

      const idx = updateScrubVisuals(e.clientX);
      if (idx !== undefined) {
        if (rangeMode) {
          if (!rangeSelection) {
            setRangeSelection({ startIdx: idx, endIdx: idx });
          } else {
            setRangeSelection((prev) =>
              prev ? { ...prev, endIdx: idx } : { startIdx: idx, endIdx: idx },
            );
          }
        }
      }

      // Attach document-level listeners
      const onMove = (ev: MouseEvent) => {
        if (!isDraggingRef.current) return;
        const newIdx = updateScrubVisuals(ev.clientX);
        if (newIdx !== undefined && rangeMode && rangeSelection) {
          setRangeSelection((prev) =>
            prev ? { ...prev, endIdx: newIdx } : null,
          );
        }
      };

      const onUp = (ev: MouseEvent) => {
        isDraggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const ts = pixelToTime(x, rect.width);
        const finalIdx = findNearest(screenshots, ts);

        if (!rangeMode) {
          setCurrentIndex(finalIdx);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [screenshots, updateScrubVisuals, pixelToTime, rangeMode, rangeSelection, setCurrentIndex, setRangeSelection],
  );

  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingRef.current || screenshots.length === 0) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ts = pixelToTime(x, rect.width);
      const idx = findNearest(screenshots, ts);
      const fraction = timeToFraction(screenshots[idx].timestamp);

      // Show hover preview
      if (hoverPreviewRef.current) {
        hoverPreviewRef.current.style.display = "block";
        hoverPreviewRef.current.style.left = `${fraction * 100}%`;
      }
      if (hoverImgRef.current && screenshots[idx].thumbnail_path) {
        hoverImgRef.current.src = getImageUrl(screenshots[idx].thumbnail_path!);
      }
      if (hoverTimeRef.current) {
        hoverTimeRef.current.textContent = formatTimeShort(screenshots[idx].timestamp);
      }
    },
    [screenshots, pixelToTime, timeToFraction],
  );

  const handleTrackMouseLeave = useCallback(() => {
    if (!isDraggingRef.current && hoverPreviewRef.current) {
      hoverPreviewRef.current.style.display = "none";
    }
  }, []);

  // -- Handle fraction from current index -----------------------------------
  const handleFraction = useMemo(() => {
    const currentScreenshot = screenshots[currentIndex] ?? null;
    if (!currentScreenshot) return 0;
    return timeToFraction(currentScreenshot.timestamp);
  }, [screenshots, currentIndex, timeToFraction]);

  // -- Time labels ----------------------------------------------------------
  const timeLabels = useMemo(() => {
    const labels: { fraction: number; label: string }[] = [];
    const rangeSeconds = endTime - startTime;
    let intervalSecs: number;
    if (rangeSeconds <= 7200) intervalSecs = 900;
    else if (rangeSeconds <= 21600) intervalSecs = 1800;
    else if (rangeSeconds <= 43200) intervalSecs = 3600;
    else intervalSecs = 7200;

    const firstBoundary = Math.ceil(startTime / intervalSecs) * intervalSecs;
    for (let t = firstBoundary; t < endTime; t += intervalSecs) {
      labels.push({
        fraction: (t - startTime) / (endTime - startTime),
        label: formatHourLabel(t),
      });
    }
    return labels;
  }, [startTime, endTime]);

  // -- Range selection fractions --------------------------------------------
  const rangeSelFractions = useMemo(() => {
    if (!rangeSelection || screenshots.length === 0) return null;
    const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
    const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
    return {
      left: timeToFraction(screenshots[lo].timestamp),
      right: timeToFraction(screenshots[hi].timestamp),
      count: hi - lo + 1,
    };
  }, [rangeSelection, screenshots, timeToFraction]);

  return {
    trackRef,
    handleRef,
    hoverPreviewRef,
    hoverImgRef,
    hoverTimeRef,
    handleTrackMouseDown,
    handleTrackMouseMove,
    handleTrackMouseLeave,
    handleFraction,
    timeLabels,
    rangeSelFractions,
    timeToFraction,
  };
}
