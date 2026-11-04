import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Results go stale with any change, so they're refetched each time the page is shown. */
export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ["search", q],
    queryFn: async () => {
      const res = await api.search.$get({ query: { q } });
      if (!res.ok) throw new Error("Could not search");
      return (await res.json()).results;
    },
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });

export type SearchResults = Awaited<ReturnType<ReturnType<typeof searchQuery>["queryFn"] & {}>>;

/** Reads the query from the URL: `/search?q=…`. */
export const validateSearchPageSearch = (search: Record<string, unknown>): { q?: string } => ({
  q: typeof search.q === "string" && search.q ? search.q.slice(0, 200) : undefined,
});
