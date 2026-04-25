import { useQuery } from "@tanstack/react-query";
import { getConfig } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

export function useConfigQuery() {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
    staleTime: 60_000,
  });
}
