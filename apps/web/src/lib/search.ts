import { keepPreviousData, queryOptions } from "@tanstack/react-query";
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
