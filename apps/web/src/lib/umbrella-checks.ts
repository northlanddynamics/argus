import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";

/**
 * Which Cisco Umbrella destination lists hold a domain (ADR 0014), through each of the
 * Organization's Umbrella Integrations. The API reads the lists when what it read lately is stale;
 * these are fetched when first wanted (the Enrichment panel opening) and kept for a while.
 */

export const umbrellaChecksKey = ["umbrella-checks"] as const;
const umbrellaCheckKey = (value: string) => [...umbrellaChecksKey, value.toLowerCase()] as const;

/** `value` is a domain or an email address; an address is checked by its domain. */
export const umbrellaCheckQuery = (value: string) =>
  queryOptions({
    queryKey: umbrellaCheckKey(value),
    queryFn: async () => {
      const res = await api["umbrella-checks"].$get({ query: { domain: value } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not check the domain in Umbrella"));
      return (await res.json()).check;
    },
    staleTime: 60_000,
    retry: false,
  });

export type UmbrellaCheck = Awaited<ReturnType<ReturnType<typeof umbrellaCheckQuery>["queryFn"] & {}>>;
export type UmbrellaIntegrationCheck = UmbrellaCheck["integrations"][number];

export function useRefreshUmbrellaCheck(value: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["umbrella-checks"].refresh.$post({ json: { domain: value } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not check the domain in Umbrella"));
      return (await res.json()).check;
    },
    onSuccess: (check) => queryClient.setQueryData(umbrellaCheckKey(value), check),
  });
}
