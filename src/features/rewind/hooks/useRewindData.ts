import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  browseScreenshots,
  getActiveBlocks,
  type TimelineEntry,
  type ActiveBlock,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { buildSegments } from "@/features/rewind/rewind-utils";

export function useRewindData(startTime: number, endTime: number) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.rewind(startTime, endTime),
    queryFn: async () => {
      const [rawScreenshots, activeBlocks] = await Promise.all([
        browseScreenshots(startTime, endTime, undefined, 100000),
        getActiveBlocks(startTime, endTime),
      ]);
      // browseScreenshots returns newest-first; we want ASC
      return {
        screenshots: rawScreenshots.reverse(),
        activeBlocks,
      };
    },
    staleTime: 30_000,
  });

  const screenshots: TimelineEntry[] = data?.screenshots ?? [];
  const activeBlocks: ActiveBlock[] = data?.activeBlocks ?? [];

  const allIds = useMemo(() => screenshots.map((s) => s.id), [screenshots]);
  const segments = useMemo(() => buildSegments(screenshots), [screenshots]);
  const totalActive = useMemo(
    () => activeBlocks.reduce((sum, b) => sum + b.duration_secs, 0),
    [activeBlocks],
  );

  return {
    screenshots,
    activeBlocks,
    segments,
    totalActive,
    allIds,
    isLoading,
  };
}
