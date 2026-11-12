import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AccountHoverCard } from "@/components/account-details";
import { Time } from "@/components/time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe } from "@/lib/api";
import { useLiveStatus } from "@/lib/live";
import { canManage } from "@/lib/roles";
import {
  type AssetType,
  assetTypeLabel,
  defang,
  type IgnoredEntry,
  ignoredQuery,
  itemPagesKey,
  type ObservableType,
  observableTypeLabel,
  refang,
  setIgnored,
  tickedTypes,
} from "@/lib/observables";
import { ItemRow } from "@/routes/observables/item-row";

const typeLabel = (e: IgnoredEntry) =>
  e.kind === "observable" ? observableTypeLabel[e.type as ObservableType] : assetTypeLabel[e.type as AssetType];
const shown = (e: IgnoredEntry) => (e.kind === "observable" ? defang(e.type as ObservableType, e.value) : e.value);

/** Whether `e` is of a ticked type (any, when none is) and contains `q`, as shown or as held. */
const matches = (e: IgnoredEntry, ticked: Set<string>, q: string) => {
  if (ticked.size && !ticked.has(e.type)) return false;
  if (!q) return true;
  const text = refang(q).toLowerCase();
  return e.value.toLowerCase().includes(text) || shown(e).toLowerCase().includes(q.toLowerCase());
};

/**
 * The Observables page's Ignored tab: the Observables and Assets on the Organization's Ignored list,
 * newest first, each with who added it, of the ticked types and containing the value searched for.
 * Items are added from their own page or menu; here Admins remove them.
 */
export function IgnoredTab() {
  const queryClient = useQueryClient();
  const me = useMe(useRouteContext({ from: "/_app" }).me);
  const admin = canManage(me.organization?.role);
  const { q = "", types } = useSearch({ from: "/_app/observables" });
  const ticked = tickedTypes(types);
  const list = useQuery(ignoredQuery);
  const rows = list.data?.filter((e) => matches(e, ticked, q));
  const [error, setError] = useState<string | null>(null);
  useLiveStatus();
  const remove = useMutation({
    mutationFn: (e: IgnoredEntry) => setIgnored(e.kind, e.id, false),
    onMutate: () => setError(null),
    onError: (e) => setError(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: itemPagesKey }),
  });

  return (
    <div className="grid grid-cols-1 gap-3">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {list.isPending && (
        <>
          <Skeleton className="h-48" />
          <span className="sr-only" role="status">
            Loading…
          </span>
        </>
      )}
      {list.isError && <p className="text-sm text-destructive">{list.error.message}</p>}
      {rows && (
        <p className="px-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {rows.length === 0
            ? list.data?.length
              ? "Nothing ignored matches."
              : "Nothing is ignored."
            : `${rows.length} ignored, most recently added first`}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul aria-label="Ignored Observables" className="divide-y overflow-hidden rounded-lg border">
          {rows.map((e) => (
            <ItemRow
              key={`${e.kind}:${e.id}`}
              kind={e.kind}
              id={e.id}
              type={e.type}
              value={e.value}
              query={q}
              detail={
                <>
                  {typeLabel(e)} · Added by {e.by.name} · <Time iso={e.at} />
                </>
              }
              aside={
                admin && (
                  <Button variant="outline" size="sm" aria-label={`Stop ignoring ${e.value}`} disabled={remove.isPending} onClick={() => remove.mutate(e)}>
                    Remove
                  </Button>
                )
              }
            >
              {(link) => (
                <AccountHoverCard assetId={e.id} account={e.value} enabled={e.kind === "asset" && e.type === "account"}>
                  {link}
                </AccountHoverCard>
              )}
            </ItemRow>
          ))}
        </ul>
      )}
    </div>
  );
}
