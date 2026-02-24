import { useState, useMemo, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createCollection } from "@/lib/api";
import { hourKeyToTimestamp } from "../history-utils";

export function useRangeSelection(mode: string, start: number, end: number) {
  const [rangeSelectMode, setRangeSelectMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  const [rangeSaveName, setRangeSaveName] = useState("");
  const [rangeSaving, setRangeSaving] = useState(false);
  const [showRangeNameInput, setShowRangeNameInput] = useState(false);

  const queryClient = useQueryClient();

  // Clear range selection when switching modes or changing date range
  const rangeResetKey = `${mode}-${start}-${end}`;
  const prevRangeResetKeyRef = useRef(rangeResetKey);
  if (prevRangeResetKeyRef.current !== rangeResetKey) {
    prevRangeResetKeyRef.current = rangeResetKey;
    setRangeSelectMode(false);
    setRangeStart(null);
    setRangeEnd(null);
    setShowRangeNameInput(false);
    setRangeSaveName("");
  }

  const handleRangeClick = useCallback(
    (timestamp: number) => {
      if (rangeStart === null || rangeEnd !== null) {
        // First click or third click (reset)
        setRangeStart(timestamp);
        setRangeEnd(null);
        setShowRangeNameInput(false);
      } else {
        // Second click -- set end, auto-sort
        const lo = Math.min(rangeStart, timestamp);
        const hi = Math.max(rangeStart, timestamp);
        setRangeStart(lo);
        setRangeEnd(hi);
      }
    },
    [rangeStart, rangeEnd],
  );

  const isEntryInRange = useCallback(
    (timestamp: number): boolean => {
      if (!rangeSelectMode || rangeStart === null) return false;
      if (rangeEnd === null) return timestamp === rangeStart;
      return timestamp >= rangeStart && timestamp <= rangeEnd;
    },
    [rangeSelectMode, rangeStart, rangeEnd],
  );

  const isHourInRange = useCallback(
    (hourKey: string): boolean => {
      if (!rangeSelectMode || rangeStart === null) return false;
      const hs = hourKeyToTimestamp(hourKey);
      const he = hs + 3600;
      if (rangeEnd === null) {
        return rangeStart >= hs && rangeStart < he;
      }
      return hs <= rangeEnd && he > rangeStart;
    },
    [rangeSelectMode, rangeStart, rangeEnd],
  );

  const rangeDisplayText = useMemo(() => {
    if (rangeStart === null) return "";
    if (rangeEnd === null) return "Click to set end point";
    const startDate = new Date(rangeStart * 1000);
    const endDate = new Date(rangeEnd * 1000);
    const timeFmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateFmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const sameDay = startDate.toDateString() === endDate.toDateString();
    if (sameDay) {
      return `${timeFmt(startDate)} \u2014 ${timeFmt(endDate)} (${dateFmt(startDate)})`;
    }
    return `${dateFmt(startDate)} ${timeFmt(startDate)} \u2014 ${dateFmt(endDate)} ${timeFmt(endDate)}`;
  }, [rangeStart, rangeEnd]);

  const handleRangeSaveAsCollection = useCallback(async () => {
    if (!rangeSaveName.trim() || rangeStart === null || rangeEnd === null) return;
    setRangeSaving(true);
    try {
      await createCollection({
        name: rangeSaveName.trim(),
        start_time: rangeStart,
        end_time: rangeEnd,
      });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      setRangeSelectMode(false);
      setRangeStart(null);
      setRangeEnd(null);
      setShowRangeNameInput(false);
      setRangeSaveName("");
    } catch (err) {
      console.error("Failed to save range collection:", err);
    } finally {
      setRangeSaving(false);
    }
  }, [rangeSaveName, rangeStart, rangeEnd, queryClient]);

  const toggleRangeSelectMode = useCallback(() => {
    setRangeSelectMode((prev) => {
      if (prev) {
        setRangeStart(null);
        setRangeEnd(null);
        setShowRangeNameInput(false);
        setRangeSaveName("");
      }
      return !prev;
    });
  }, []);

  const clearRange = useCallback(() => {
    setRangeStart(null);
    setRangeEnd(null);
    setShowRangeNameInput(false);
  }, []);

  const exitRangeSelect = useCallback(() => {
    setRangeSelectMode(false);
    setRangeStart(null);
    setRangeEnd(null);
    setShowRangeNameInput(false);
    setRangeSaveName("");
  }, []);

  return {
    rangeSelectMode,
    setRangeSelectMode,
    rangeStart,
    rangeEnd,
    rangeSaveName,
    setRangeSaveName,
    rangeSaving,
    showRangeNameInput,
    setShowRangeNameInput,
    handleRangeClick,
    isEntryInRange,
    isHourInRange,
    rangeDisplayText,
    handleRangeSaveAsCollection,
    toggleRangeSelectMode,
    clearRange,
    exitRangeSelect,
  };
}
