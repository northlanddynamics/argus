import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";

export { asTypeLabel, type IpDetails } from "api/ipinfo/ipinfo";

/** Every IP lookup's query starts with this key; an Integration signal refreshes them. */
export const ipLookupsKey = ["ip-lookups"] as const;
const ipLookupKey = (ip: string) => [...ipLookupsKey, ip] as const;

/**
 * What the Organization's IPinfo Integration says about `ip` (ADR 0010). The API answers from its
 * cache, asking IPinfo only when nothing fresh is cached, so this is fetched when first wanted (a
 * popup opening) and then kept for the session.
 */
export const ipLookupQuery = (ip: string) =>
  queryOptions({
    queryKey: ipLookupKey(ip),
    queryFn: async () => {
      const res = await api["ip-lookups"].$get({ query: { ip } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not look the IP up"));
      return (await res.json()).lookup;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export type IpLookup = Awaited<ReturnType<ReturnType<typeof ipLookupQuery>["queryFn"] & {}>>;

/** Asks IPinfo again about `ip`, whatever is cached. */
export function useRefreshIpLookup(ip: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["ip-lookups"].refresh.$post({ json: { ip } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the IP"));
      return (await res.json()).lookup;
    },
    onSuccess: (lookup) => queryClient.setQueryData(ipLookupKey(ip), lookup),
  });
}
