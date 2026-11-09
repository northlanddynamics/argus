import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellIcon, BellOffIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { meQuery } from "@/lib/api";
import { casesKey } from "@/lib/cases";
import { defang, ignoredQuery, itemPagesKey, normaliseObservable, type ObservableType, observableTypeLabel, setIgnoredByValue } from "@/lib/observables";
import { canManage } from "@/lib/roles";

/**
 * Ignoring an Observable wherever it is shown (its right-click menu, a Case's row menu, the
 * Enrichment panel), as on its own page: Admins put it on the Organization's Ignored list, which
 * reaches every Case, so it asks first; taking it off doesn't.
 */
export function useObservableIgnore(type: ObservableType, value: string) {
  const queryClient = useQueryClient();
  const admin = canManage(useQuery(meQuery).data?.organization?.role);
  const list = useQuery({ ...ignoredQuery, enabled: admin });
  const normalised = normaliseObservable(type, value)?.value ?? null;
  const ignored = !!normalised && !!list.data?.some((e) => e.kind === "observable" && e.type === type && e.value === normalised);
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({
    mutationFn: (to: boolean) => setIgnoredByValue(type, value, to),
    onSuccess: (_, to) => {
      setConfirming(false);
      toast(to ? "Added to the Ignored list" : "Removed from the Ignored list");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: itemPagesKey });
      void queryClient.invalidateQueries({ queryKey: casesKey });
    },
  });
  return {
    /** Only Admins may, and only for a valid value. */
    available: admin && normalised !== null && list.isSuccess,
    ignored,
    pending: toggle.isPending,
    /** Ignore asks first; Stop ignoring doesn't. */
    request: () => (ignored ? toggle.mutate(false) : setConfirming(true)),
    dialog: (
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ignore this {observableTypeLabel[type]}?</AlertDialogTitle>
            <AlertDialogDescription className="grid gap-2">
              <span className="font-mono text-xs [overflow-wrap:anywhere]">{defang(type, value)}</span>
              <span>It goes on the Organization's Ignored list and never drives a Correlation, on any Case.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={toggle.isPending}
              onClick={(e) => {
                e.preventDefault();
                toggle.mutate(true);
              }}
            >
              Ignore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}

export type ObservableIgnore = ReturnType<typeof useObservableIgnore>;

type ItemComponent = ComponentType<{ onSelect?: (event: Event) => void; disabled?: boolean; children: ReactNode }>;

/** "Ignore…" or "Stop ignoring" in a menu; nothing for those who can't. Render `ignore.dialog` outside the menu. */
export function ObservableIgnoreItem({ Item, ignore }: { Item: ItemComponent; ignore: ObservableIgnore }) {
  if (!ignore.available) return null;
  return (
    <Item disabled={ignore.pending} onSelect={ignore.request}>
      {ignore.ignored ? <BellIcon aria-hidden /> : <BellOffIcon aria-hidden />}
      {ignore.ignored ? "Stop ignoring" : "Ignore…"}
    </Item>
  );
}
