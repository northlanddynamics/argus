import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export { normaliseTag, TAG_EXPECTED, tagLabel } from "api/tags/vocabulary";

/** Under the Case list's key, so any Case's live signal refreshes it. */
export const tagsInUseKey = ["cases", "tags"] as const;

/** The Tags on Cases the Member can see, for the Case list's Tag filter. */
export const tagsInUseQuery = queryOptions({
  queryKey: tagsInUseKey,
  queryFn: async () => {
    const res = await api.cases.tags.$get();
    if (!res.ok) throw new Error("Could not load the Tags");
    return (await res.json()).tags;
  },
});
