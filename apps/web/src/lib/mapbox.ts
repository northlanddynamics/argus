import { queryOptions } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";

export const mapboxKey = ["mapbox"] as const;

/** The Organization's Mapbox public token, set in Settings · Integrations; `token` null when none is set. */
export const mapboxQuery = queryOptions({
  queryKey: mapboxKey,
  queryFn: async () => {
    const res = await api.mapbox.$get();
    if (!res.ok) throw new Error(await errorMessage(res, "Could not load the Mapbox token"));
    return (await res.json()).mapbox;
  },
  staleTime: 30 * 60_000,
});
