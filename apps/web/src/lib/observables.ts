import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api";

export {
  ASSET_TYPES,
  type AssetType,
  assetTypeLabel,
  defang,
  OBSERVABLE_TYPES,
  type ObservableType,
  observableTypeLabel,
} from "api/observables/vocabulary";

/** Under the Case's key, so its live signal refreshes them. */
export const observablesKey = (number: number) => ["cases", number, "observables"] as const;
export const assetsKey = (number: number) => ["cases", number, "assets"] as const;

export const observablesQuery = (number: number) =>
  queryOptions({
    queryKey: observablesKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].observables.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Observables");
      return (await res.json()).observables;
    },
  });

export const assetsQuery = (number: number) =>
  queryOptions({
    queryKey: assetsKey(number),
    queryFn: async () => {
      const res = await api.cases[":number"].assets.$get({ param: { number: String(number) } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Could not load the Assets");
      return (await res.json()).assets;
    },
  });
