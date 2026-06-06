import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  listMeetings, deleteMeeting, startMeeting, stopMeeting, getDaemonStatus,
} from "@/lib/api";

export function useMeetingsList() {
  return useQuery({
    queryKey: queryKeys.meetings(100, 0),
    queryFn: () => listMeetings(100, 0),
    staleTime: 15_000,
  });
}

export function useMeetingStatus() {
  return useQuery({
    queryKey: ["daemon-status-meeting"],
    queryFn: getDaemonStatus,
    refetchInterval: 3_000,
    staleTime: 0,
  });
}

export function useMeetingActions() {
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: (title: string) => startMeeting(title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["daemon-status-meeting"] });
      qc.invalidateQueries({ queryKey: queryKeys.meetings(100, 0) });
    },
  });
  const stop = useMutation({
    mutationFn: () => stopMeeting(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["daemon-status-meeting"] });
      qc.invalidateQueries({ queryKey: queryKeys.meetings(100, 0) });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteMeeting(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.meetings(100, 0) }),
  });
  return { start, stop, remove };
}
