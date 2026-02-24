import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getJournalEntry,
  upsertJournalEntry,
  getJournalDates,
  getJournalStreak,
  getJournalScreenshots,
  addJournalScreenshot,
  removeJournalScreenshot,
  getActivity,
  getTaskBreakdown,
  getJournalTags,
  askHealth,
  type JournalDateInfo,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useDebounce } from "@/hooks/useDebounce";
import { dateToKey, dayStartEnd } from "@/lib/time-ranges";
import {
  addDays,
  subDays,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  isSameDay,
  format,
} from "date-fns";

export function useJournalEntry() {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [mood, setMood] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [showScreenshotPicker, setShowScreenshotPicker] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [contentKey, setContentKey] = useState(0);
  const queryClient = useQueryClient();

  const dateKey = dateToKey(selectedDate);
  const [dayStart, dayEnd] = dayStartEnd(selectedDate);

  // ── Data queries ──

  const { data: entry, isLoading: entryLoading } = useQuery({
    queryKey: queryKeys.journalEntry(dateKey),
    queryFn: () => getJournalEntry(dateKey),
  });

  const { data: streak } = useQuery({
    queryKey: queryKeys.journalStreak(),
    queryFn: getJournalStreak,
    staleTime: 60_000,
  });

  const calendarMonth = useMemo(() => startOfMonth(selectedDate), [selectedDate]);
  const calendarStart = dateToKey(startOfMonth(subMonths(calendarMonth, 1)));
  const calendarEnd = dateToKey(endOfMonth(addMonths(calendarMonth, 1)));

  const { data: journalDates = [] } = useQuery({
    queryKey: queryKeys.journalDates(calendarStart, calendarEnd),
    queryFn: () => getJournalDates(calendarStart, calendarEnd),
    staleTime: 30_000,
  });

  const journalDateMap = useMemo(() => {
    const map = new Map<string, JournalDateInfo>();
    for (const d of journalDates) map.set(d.date, d);
    return map;
  }, [journalDates]);

  const { data: entryTags = [] } = useQuery({
    queryKey: queryKeys.journalTags(entry?.id ?? 0),
    queryFn: () => getJournalTags(entry!.id),
    enabled: !!entry?.id,
  });

  const { data: activityData } = useQuery({
    queryKey: queryKeys.activity(dayStart, dayEnd),
    queryFn: () => getActivity(dayStart, dayEnd),
    staleTime: 60_000,
  });

  const { data: taskBreakdown = [] } = useQuery({
    queryKey: ["task-breakdown", dayStart, dayEnd],
    queryFn: () => getTaskBreakdown(dayStart, dayEnd, 10),
    staleTime: 60_000,
  });

  const { data: journalScreenshots = [] } = useQuery({
    queryKey: queryKeys.journalScreenshots(entry?.id ?? 0),
    queryFn: () => getJournalScreenshots(entry!.id),
    enabled: !!entry?.id,
  });

  const { data: ollamaAvailable } = useQuery({
    queryKey: queryKeys.askHealth(),
    queryFn: askHealth,
    staleTime: 120_000,
  });

  // ── Sync content from fetched entry ──

  useEffect(() => {
    if (!entryLoading) {
      setContent(entry?.content ?? "");
      setMood(entry?.mood ?? null);
      setEnergy(entry?.energy ?? null);
    }
  }, [entry, entryLoading]);

  // ── Prefetch adjacent days ──

  useEffect(() => {
    const prevKey = dateToKey(subDays(selectedDate, 1));
    const nextKey = dateToKey(addDays(selectedDate, 1));
    queryClient.prefetchQuery({
      queryKey: queryKeys.journalEntry(prevKey),
      queryFn: () => getJournalEntry(prevKey),
    });
    queryClient.prefetchQuery({
      queryKey: queryKeys.journalEntry(nextKey),
      queryFn: () => getJournalEntry(nextKey),
    });
  }, [selectedDate, queryClient]);

  // ── Auto-save with debounce ──

  const debouncedContent = useDebounce(content, 800);
  const debouncedMood = useDebounce(mood, 800);
  const debouncedEnergy = useDebounce(energy, 800);

  const saveMutation = useMutation({
    mutationFn: (data: { content: string; mood: number | null; energy: number | null }) =>
      upsertJournalEntry({ date: dateKey, content: data.content, mood: data.mood, energy: data.energy }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.journalStreak() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.journalDates(calendarStart, calendarEnd),
      });
    },
  });

  useEffect(() => {
    const stored = entry?.content ?? "";
    const storedMood = entry?.mood ?? null;
    const storedEnergy = entry?.energy ?? null;
    if (
      (debouncedContent !== stored || debouncedMood !== storedMood || debouncedEnergy !== storedEnergy) &&
      !entryLoading
    ) {
      saveMutation.mutate({ content: debouncedContent, mood: debouncedMood, energy: debouncedEnergy });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedContent, debouncedMood, debouncedEnergy]);

  // ── Screenshot attach / detach ──

  const attachMutation = useMutation({
    mutationFn: async (screenshotId: number) => {
      const entryId = await upsertJournalEntry({ date: dateKey, content, mood, energy });
      await addJournalScreenshot(entryId, screenshotId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.journalEntry(dateKey) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.journalScreenshots(entry?.id ?? 0),
      });
    },
  });

  const detachMutation = useMutation({
    mutationFn: (screenshotId: number) =>
      removeJournalScreenshot(entry!.id, screenshotId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.journalScreenshots(entry?.id ?? 0),
      });
    },
  });

  // ── Navigation ──

  const goToDate = useCallback(
    (d: Date) => {
      setSelectedDate(d);
      setContentKey((k) => k + 1);
      setShowScreenshotPicker(false);
      setShowSearch(false);
    },
    [],
  );

  const goToPrev = useCallback(() => {
    goToDate(subDays(selectedDate, 1));
  }, [selectedDate, goToDate]);

  const goToNext = useCallback(() => {
    goToDate(addDays(selectedDate, 1));
  }, [selectedDate, goToDate]);

  const goToToday = useCallback(() => {
    goToDate(new Date());
  }, [goToDate]);

  const isToday = isSameDay(selectedDate, new Date());

  // Alt+Left/Right keyboard nav
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goToDate(subDays(selectedDate, 1));
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        if (!isToday) goToDate(addDays(selectedDate, 1));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedDate, isToday, goToDate]);

  // ── Writing stats ──

  const wordCount = useMemo(
    () => (content.trim() ? content.trim().split(/\s+/).length : 0),
    [content],
  );
  const readingTime = Math.max(1, Math.ceil(wordCount / 200));

  // ── Memory jogger prompts ──

  const prompts = useMemo(() => {
    if (!activityData || activityData.total_screenshots === 0) return [];
    const p: string[] = [];
    const topApps = activityData.app_usage.slice(0, 3);
    for (const app of topApps) {
      const mins = Math.round((app.screenshot_count * 5) / 60 * 10) / 10;
      if (mins >= 5) {
        p.push(
          `You spent ~${mins >= 60 ? `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m` : `${Math.round(mins)}m`} in ${app.app_name} — what did you work on?`,
        );
      }
    }
    for (const task of taskBreakdown.slice(0, 2)) {
      if (task.window_title && task.estimated_seconds > 300) {
        p.push(`You had "${task.window_title}" open — any notes?`);
      }
    }
    if (p.length === 0 && activityData.total_screenshots > 0) {
      p.push(`${activityData.total_screenshots} screenshots captured today — what were you up to?`);
    }
    return p.slice(0, 4);
  }, [activityData, taskBreakdown]);

  // ── Derived ──

  const formattedDate = format(selectedDate, "EEEE, MMM d, yyyy");
  const isSaving = saveMutation.isPending;
  const isUnsaved = content !== (entry?.content ?? "");
  return {
    // Date navigation
    selectedDate,
    dateKey,
    dayStart,
    dayEnd,
    formattedDate,
    isToday,
    goToDate,
    goToPrev,
    goToNext,
    goToToday,
    contentKey,

    // Content
    content,
    setContent,
    mood,
    setMood,
    energy,
    setEnergy,
    entryLoading,
    isSaving,
    isUnsaved,
    // Entry & tags
    entry,
    entryTags,

    // Calendar
    calendarMonth,
    journalDateMap,

    // Sidebar data
    streak,
    ollamaAvailable,
    activityData,
    prompts,

    // Screenshots
    journalScreenshots,
    showScreenshotPicker,
    setShowScreenshotPicker,
    attachMutation,
    detachMutation,

    // Panels
    showSearch,
    setShowSearch,
    showExport,
    setShowExport,

    // Stats
    wordCount,
    readingTime,

    // Query client access for tag invalidation
    queryClient,
  };
}
