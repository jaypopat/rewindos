import { useCallback, useRef } from "react";
import type { TimelineEntry } from "@/lib/api";

interface UseRewindKeyboardOptions {
  screenshots: TimelineEntry[];
  currentIndex: number;
  setCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  isPlaying: boolean;
  setIsPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  rangeMode: boolean;
  setRangeMode: (mode: boolean) => void;
  rangeSelection: { startIdx: number; endIdx: number } | null;
  setRangeSelection: React.Dispatch<
    React.SetStateAction<{ startIdx: number; endIdx: number } | null>
  >;
  setShowDeleteConfirm: (show: boolean) => void;
  currentScreenshot: TimelineEntry | null;
  allIds: number[];
  onSelectScreenshot: (id: number, siblingIds?: number[]) => void;
}

export function useRewindKeyboard({
  screenshots,
  currentIndex,
  setCurrentIndex,
  setIsPlaying,
  rangeMode,
  setRangeMode,
  rangeSelection,
  setRangeSelection,
  setShowDeleteConfirm,
  currentScreenshot,
  allIds,
  onSelectScreenshot,
}: UseRewindKeyboardOptions) {
  const holdIntervalRef = useRef<number>(0);
  const holdDirectionRef = useRef<number>(0);
  const holdCountRef = useRef<number>(0);

  const startHold = useCallback(
    (direction: number) => {
      holdDirectionRef.current = direction;
      holdCountRef.current = 0;
      const tick = () => {
        holdCountRef.current++;
        const delay =
          holdCountRef.current < 5 ? 150 : holdCountRef.current < 15 ? 80 : 40;
        setCurrentIndex((prev) => {
          const next = Math.max(0, Math.min(screenshots.length - 1, prev + direction));
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: next } : { startIdx: prev, endIdx: next },
            );
          }
          return next;
        });
        holdIntervalRef.current = window.setTimeout(tick, delay);
      };
      holdIntervalRef.current = window.setTimeout(tick, 300);
    },
    [screenshots.length, rangeMode, setCurrentIndex, setRangeSelection],
  );

  const stopHold = useCallback(() => {
    if (holdIntervalRef.current) {
      clearTimeout(holdIntervalRef.current);
      holdIntervalRef.current = 0;
    }
    holdDirectionRef.current = 0;
    holdCountRef.current = 0;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const moveIndex = (direction: number) => {
        setCurrentIndex((prev) => {
          const next = Math.max(0, Math.min(screenshots.length - 1, prev + direction));
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: next } : { startIdx: prev, endIdx: next },
            );
          }
          return next;
        });
      };

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (!holdDirectionRef.current) {
            moveIndex(-1);
            startHold(-1);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (!holdDirectionRef.current) {
            moveIndex(1);
            startHold(1);
          }
          break;
        case "Home":
          e.preventDefault();
          setCurrentIndex(0);
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel ? { ...sel, endIdx: 0 } : { startIdx: currentIndex, endIdx: 0 },
            );
          }
          break;
        case "End":
          e.preventDefault();
          setCurrentIndex(screenshots.length - 1);
          if (rangeMode) {
            setRangeSelection((sel) =>
              sel
                ? { ...sel, endIdx: screenshots.length - 1 }
                : { startIdx: currentIndex, endIdx: screenshots.length - 1 },
            );
          }
          break;
        case " ":
          e.preventDefault();
          if (!rangeMode) setIsPlaying((prev) => !prev);
          break;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (rangeMode && rangeSelection) {
            const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
            const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
            if (hi > lo) setShowDeleteConfirm(true);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (rangeMode && rangeSelection) {
            const lo = Math.min(rangeSelection.startIdx, rangeSelection.endIdx);
            const hi = Math.max(rangeSelection.startIdx, rangeSelection.endIdx);
            if (hi > lo) setShowDeleteConfirm(true);
          } else if (currentScreenshot) {
            onSelectScreenshot(currentScreenshot.id, allIds);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (rangeMode) {
            setRangeSelection(null);
            setRangeMode(false);
          }
          break;
      }
    },
    [
      screenshots.length,
      currentIndex,
      currentScreenshot,
      allIds,
      rangeMode,
      rangeSelection,
      onSelectScreenshot,
      startHold,
      setCurrentIndex,
      setIsPlaying,
      setRangeSelection,
      setRangeMode,
      setShowDeleteConfirm,
    ],
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        stopHold();
      }
    },
    [stopHold],
  );

  return { handleKeyDown, handleKeyUp };
}
