import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StarIcon, StarOffIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { toast } from "sonner";
import { meQuery } from "@/lib/api";
import { casesKey } from "@/lib/cases";
import { alertsKey } from "@/lib/alerts";
import { importantQuery, itemPagesKey, normaliseObservable, type ObservableType, setImportantByValue } from "@/lib/observables";

/**
 * Marking an Observable Important wherever it is shown (its right-click menu, a Case's row menu, the
 * Enrichment panel), as on its own page: any Member marks it, Organization-wide, and only Important
 * Observables relate Alerts to Cases (Correlation). Easily undone, so it doesn't ask first.
 */
export function useObservableImportant(type: ObservableType, value: string) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery).data;
  const member = !!me?.organization && !me.guest;
  const list = useQuery({ ...importantQuery, enabled: member });
  const normalised = normaliseObservable(type, value)?.value ?? null;
  const important = !!normalised && !!list.data?.some((e) => e.type === type && e.value === normalised);
  const toggle = useMutation({
    mutationFn: (to: boolean) => setImportantByValue(type, value, to),
    onSuccess: (_, to) => toast(to ? "Marked Important" : "No longer Important"),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: itemPagesKey });
      void queryClient.invalidateQueries({ queryKey: casesKey });
      void queryClient.invalidateQueries({ queryKey: alertsKey });
    },
  });
  return {
    /** Only Members may, and only for a valid value. */
    available: member && normalised !== null && list.isSuccess,
    important,
    pending: toggle.isPending,
    toggle: () => toggle.mutate(!important),
  };
}

export type ObservableImportant = ReturnType<typeof useObservableImportant>;

type ItemComponent = ComponentType<{ onSelect?: (event: Event) => void; disabled?: boolean; children: ReactNode }>;

/** "Mark Important" or "Unmark Important" in a menu; nothing for those who can't. */
export function ObservableImportantItem({ Item, important }: { Item: ItemComponent; important: ObservableImportant }) {
  if (!important.available) return null;
  return (
    <Item disabled={important.pending} onSelect={important.toggle}>
      {important.important ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
      {important.important ? "Unmark Important" : "Mark Important"}
    </Item>
  );
}
