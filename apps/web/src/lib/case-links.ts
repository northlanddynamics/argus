import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export { LINK_TYPES, type LinkSide, linkSideLabel, type LinkType } from "api/case-links/vocabulary";

/** Under the Case's key, so its live signal refreshes them. */
export const linksKey = (number: number) => ["cases", number, "links"] as const;

export const linksQuery = (number: number) =>
  queryOptions({
    queryKey: linksKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].links.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the linked Cases");
      return (await res.json()).links;
    },
  });
