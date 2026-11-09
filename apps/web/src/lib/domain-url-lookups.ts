import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";

export type { DomainReport, UrlReport } from "api/virustotal/virustotal";

/**
 * What VirusTotal says about domains, email addresses (by their domain) and URLs (ADR 0012). As for
 * hashes (`hash-lookups.ts`), the API answers from the Organization's cache, asking VirusTotal with
 * the Member's own key only when nothing fresh is cached, so these are fetched when first wanted (a
 * popup opening) and then kept for the session.
 */

/** Every domain and URL lookup's query starts with one of these keys. */
export const domainLookupsKey = ["domain-lookups"] as const;
export const urlLookupsKey = ["url-lookups"] as const;
const domainLookupKey = (value: string) => [...domainLookupsKey, value.toLowerCase()] as const;
const urlLookupKey = (url: string) => [...urlLookupsKey, url] as const;

/** `value` is a domain or an email address; an address is looked up by its domain. */
export const domainLookupQuery = (value: string) =>
  queryOptions({
    queryKey: domainLookupKey(value),
    queryFn: async () => {
      const res = await api["domain-lookups"].$get({ query: { domain: value } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not look the domain up"));
      return (await res.json()).lookup;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export type DomainLookup = Awaited<ReturnType<ReturnType<typeof domainLookupQuery>["queryFn"] & {}>>;

export function useRefreshDomainLookup(value: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["domain-lookups"].refresh.$post({ json: { domain: value } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the domain"));
      return (await res.json()).lookup;
    },
    onSuccess: (lookup) => queryClient.setQueryData(domainLookupKey(value), lookup),
  });
}

export const urlLookupQuery = (url: string) =>
  queryOptions({
    queryKey: urlLookupKey(url),
    queryFn: async () => {
      const res = await api["url-lookups"].$get({ query: { url } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not look the URL up"));
      return (await res.json()).lookup;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export type UrlLookup = Awaited<ReturnType<ReturnType<typeof urlLookupQuery>["queryFn"] & {}>>;

export function useRefreshUrlLookup(url: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api["url-lookups"].refresh.$post({ json: { url } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the URL"));
      return (await res.json()).lookup;
    },
    onSuccess: (lookup) => queryClient.setQueryData(urlLookupKey(url), lookup),
  });
}
