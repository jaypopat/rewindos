import { useQuery } from "@tanstack/react-query";
import { getConfig } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { type AppConfig } from "@/lib/config";

export function useConfigQuery() {
  return useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => getConfig() as unknown as Promise<AppConfig>,
    staleTime: 60_000,
  });
}
