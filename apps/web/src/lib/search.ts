import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { SEARCH_KINDS, type SearchKind } from "api/search/vocabulary";
import { api } from "@/lib/api";

export { SEARCH_KINDS, type SearchKind, searchKindLabel } from "api/search/vocabulary";

/** A search: the words, the kinds to list (every kind when empty) and which page. */
export type SearchParams = { q: string; kinds: SearchKind[]; page?: number; pageSize?: number };

export const searchQuery = ({ q, kinds, page = 1, pageSize }: SearchParams) =>
  queryOptions({
    queryKey: ["search", q.trim(), kinds.toSorted().join(","), page, pageSize ?? null],
    queryFn: async () => {
      const res = await api.search.$get({
        query: {
          q: q.trim(),
          ...(kinds.length ? { kinds: kinds.join(",") } : {}),
          ...(page > 1 ? { page: String(page) } : {}),
          ...(pageSize ? { pageSize: String(pageSize) } : {}),
        },
      });
      if (!res.ok) throw new Error("Could not search");
      return (await res.json()).results;
    },
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

export type SearchResults = Awaited<ReturnType<ReturnType<typeof searchQuery>["queryFn"] & {}>>;
/** One result, of any kind. */
export type SearchHit = SearchResults["hits"][number];

/** A key for a result, unique across kinds. */
export const hitKey = (hit: SearchHit) => (hit.kind === "cases" ? `case:${hit.item.number}` : `${hit.kind}:${hit.item.id}`);

/** Reads the kinds from the URL (`kinds=cases,alerts`), ignoring anything unknown. */
export const parseKinds = (value: unknown): SearchKind[] =>
  typeof value === "string" ? SEARCH_KINDS.filter((k) => value.split(",").includes(k)) : [];

export type SearchPageSearch = { q?: string; kinds?: string; page?: number };

/** Reads the results page's query, kinds and page from the URL: `/search?q=…&kinds=cases,alerts&page=2`. */
export const validateSearchPageSearch = (search: Record<string, unknown>): SearchPageSearch => {
  const kinds = parseKinds(search.kinds);
  const page = Number(search.page);
  return {
    q: typeof search.q === "string" && search.q ? search.q.slice(0, 200) : undefined,
    kinds: kinds.length ? kinds.join(",") : undefined,
    page: Number.isInteger(page) && page > 1 ? Math.min(page, 10_000) : undefined,
  };
};

/**
 * The router's URL search reading and writing, with `q` kept as typed. The router otherwise reads
 * every value as JSON, so a pasted `/search?q=185.220` would read as the number 185.22 and
 * `?q="invoice portal"` would lose its quotes.
 */
export function parseSearch(searchStr: string) {
  const parsed: Record<string, unknown> = defaultParseSearch(searchStr);
  const q = new URLSearchParams(searchStr.replace(/^\?/, "")).get("q");
  if (q !== null) parsed.q = q;
  return parsed;
}

export function stringifySearch(search: Record<string, unknown>) {
  const { q, ...rest } = search;
  const others = defaultStringifySearch(rest).replace(/^\?/, "");
  if (q === undefined || q === null || q === "") return others ? `?${others}` : "";
  const query = `q=${encodeURIComponent(String(q))}`;
  return `?${others ? `${query}&${others}` : query}`;
}

/** The search syntax, said once wherever a search is typed. */
export const SEARCH_SYNTAX = "\"quotes\" for a phrase · -word to leave out · IPs and hashes match from the start";

/**
 * What to try when `q` finds nothing, read from what it looks like: part of an IP, a short run of hex,
 * or words.
 */
export function noMatchHint(q: string) {
  const text = q.trim();
  if (/^\d{1,3}(\.\d{0,3}){0,2}$/.test(text)) return "IPs match by whole parts from the start: try 185.220 or the full address.";
  if (/^[0-9a-f]{1,7}$/i.test(text)) return "Hashes match from their first 4 characters when they mix digits and letters, or from 8.";
  return "Check the spelling or try fewer words. Domains, URLs and email addresses can be pasted defanged.";
}
