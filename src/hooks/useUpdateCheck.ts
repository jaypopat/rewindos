import { useQuery } from "@tanstack/react-query";
import { checkForUpdate } from "@/lib/api";

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Shared by the Settings section and the global toast — one cache entry. */
export function useUpdateCheck() {
  return useQuery({
    queryKey: ["update-check"],
    queryFn: checkForUpdate,
    refetchInterval: SIX_HOURS,
    staleTime: SIX_HOURS,
    refetchOnWindowFocus: false,
    retry: false, // background check is silent; manual check uses refetch()
  });
}
