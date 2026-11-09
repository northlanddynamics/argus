import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { domainLookupsKey, urlLookupsKey } from "@/lib/domain-url-lookups";

export { type FileReport, type HashType, enginesThatAnalysed } from "api/virustotal/virustotal";

/** Every hash lookup's query starts with this key. */
export const hashLookupsKey = ["hash-lookups"] as const;
const hashLookupKey = (hash: string) => [...hashLookupsKey, hash.toLowerCase()] as const;
export const virustotalKeyKey = ["virustotal-key"] as const;

/**
 * What VirusTotal says about the file `hash` identifies (ADR 0011). The API answers from the
 * Organization's cache, asking VirusTotal with the Member's own key only when nothing fresh is
 * cached, so this is fetched when first wanted (a popup opening) and then kept for the session.
 */
export const hashLookupQuery = (hash: string) =>
  queryOptions({
    queryKey: hashLookupKey(hash),
    queryFn: async () => {
      const res = await api["hash-lookups"].$get({ query: { hash } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not look the hash up"));
      return (await res.json()).lookup;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export type HashLookup = Awaited<ReturnType<ReturnType<typeof hashLookupQuery>["queryFn"] & {}>>;

/** Asks VirusTotal again about `hash`, whatever is cached. */
export function useRefreshHashLookup(hash: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["hash-lookups"].refresh.$post({ json: { hash } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the hash"));
      return (await res.json()).lookup;
    },
    onSuccess: (lookup) => queryClient.setQueryData(hashLookupKey(hash), lookup),
  });
}

/** The signed-in Member's own VirusTotal key: its last four characters and how it last went, or null. */
export const virustotalKeyQuery = queryOptions({
  queryKey: virustotalKeyKey,
  queryFn: async () => {
    const res = await api["virustotal-key"].$get();
    if (!res.ok) throw new Error(await errorMessage(res, "Could not load your VirusTotal key"));
    return (await res.json()).key;
  },
});

/** After the key changes, lookups that had none, or failed with the old one, are asked again: hashes, domains and URLs. */
const keyChanged = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: virustotalKeyKey }),
    queryClient.invalidateQueries({ queryKey: hashLookupsKey }),
    queryClient.invalidateQueries({ queryKey: domainLookupsKey }),
    queryClient.invalidateQueries({ queryKey: urlLookupsKey }),
  ]);

/** Sets or replaces the Member's own key; VirusTotal checks it first. */
export function useSetVirustotalKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (apiKey: string) => {
      const res = await api["virustotal-key"].$put({ json: { apiKey } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not save your VirusTotal key"));
      return (await res.json()).key;
    },
    onSuccess: () => keyChanged(queryClient),
  });
}

export function useRemoveVirustotalKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["virustotal-key"].$delete();
      if (!res.ok) throw new Error(await errorMessage(res, "Could not remove your VirusTotal key"));
    },
    onSuccess: () => keyChanged(queryClient),
  });
}
