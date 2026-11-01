import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InternalItem } from "api/internal/vocabulary";
import { alertsKey } from "@/lib/alerts";
import { api, errorMessage } from "@/lib/api";
import { caseKey } from "@/lib/cases";

export type { InternalItem };

/**
 * Marks an item on Case `number` Internal (hidden from its Guests), or shows it to them again.
 * Refreshes everything on the Case, since any of its lists may hold the item.
 */
export function useMarkInternal(number: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, internal }: { item: InternalItem; internal: boolean }) => {
      const res = await api.cases[":number"].internal.$put({ param: { number: String(number) }, json: { item, internal } });
      if (!res.ok) throw new Error(await errorMessage(res, internal ? "Could not mark it Internal" : "Could not show it to Guests"));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: caseKey(number) });
      void queryClient.invalidateQueries({ queryKey: alertsKey });
    },
  });
}
