import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { SEARCH_KINDS, type SearchKind } from "api/search/vocabulary";
import { api } from "@/lib/api";

export { SEARCH_KINDS, type SearchKind, searchKindLabel } from "api/search/vocabulary";

/** A search: the words, and the kinds to look through (every kind when empty). */
export type SearchParams = { q: string; kinds: SearchKind[]; limit?: number };

export const searchQuery = ({ q, kinds, limit }: SearchParams) =>
  queryOptions({
    queryKey: ["search", q.trim(), kinds.toSorted().join(","), limit ?? null],
    queryFn: async () => {
      const res = await api.search.$get({
        query: { q: q.trim(), ...(kinds.length ? { kinds: kinds.join(",") } : {}), ...(limit ? { limit: String(limit) } : {}) },
      });
      if (!res.ok) throw new Error("Could not search");
      return (await res.json()).results;
    },
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

export type SearchResults = Awaited<ReturnType<ReturnType<typeof searchQuery>["queryFn"] & {}>>;

/** One result of any kind, as the search box and the results page list them. */
export type SearchHit =
  | { kind: "cases"; key: string; rank: number; item: SearchResults["cases"][number] }
  | { kind: "alerts"; key: string; rank: number; item: SearchResults["alerts"][number] }
  | { kind: "observables"; key: string; rank: number; item: SearchResults["observables"][number] }
  | { kind: "assets"; key: string; rank: number; item: SearchResults["assets"][number] };

/** The results of one kind as hits, best first. */
export function hitsOf(results: SearchResults, kind: SearchKind): SearchHit[] {
  switch (kind) {
    case "cases":
      return results.cases.map((item) => ({ kind, key: `case:${item.number}`, rank: item.rank, item }));
    case "alerts":
      return results.alerts.map((item) => ({ kind, key: `alert:${item.id}`, rank: item.rank, item }));
    case "observables":
      return results.observables.map((item) => ({ kind, key: `observable:${item.id}`, rank: item.rank, item }));
    case "assets":
      return results.assets.map((item) => ({ kind, key: `asset:${item.id}`, rank: item.rank, item }));
  }
}

/** The best `n` results across every kind; ties go to the kind listed first. */
export const topHits = (results: SearchResults, n: number) =>
  SEARCH_KINDS.flatMap((kind) => hitsOf(results, kind))
    .toSorted((a, b) => b.rank - a.rank)
    .slice(0, n);

/** Reads the kinds from the URL (`kinds=cases,alerts`), ignoring anything unknown. */
export const parseKinds = (value: unknown): SearchKind[] =>
  typeof value === "string" ? SEARCH_KINDS.filter((k) => value.split(",").includes(k)) : [];

export type SearchPageSearch = { q?: string; kinds?: string };

/** Reads the results page's query and kinds from the URL: `/search?q=…&kinds=cases,alerts`. */
export const validateSearchPageSearch = (search: Record<string, unknown>): SearchPageSearch => {
  const kinds = parseKinds(search.kinds);
  return {
    q: typeof search.q === "string" && search.q ? search.q.slice(0, 200) : undefined,
    kinds: kinds.length ? kinds.join(",") : undefined,
  };
};
