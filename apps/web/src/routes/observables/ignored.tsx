import { ObservableMenu } from "@/components/observable-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Time } from "@/components/time";
import { AccountHoverCard } from "@/components/account-details";
import { ItemLink } from "@/components/item-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

const typeLabel = (e: IgnoredEntry) =>
  e.kind === "observable" ? observableTypeLabel[e.type as ObservableType] : assetTypeLabel[e.type as AssetType];
const shown = (e: IgnoredEntry) => (e.kind === "observable" ? defang(e.type as ObservableType, e.value) : e.value);

/** The Added by column: shown from `sm`; below it its cells stay in the row, emptied, so the columns keep their widths. */
const fromSm = "overflow-hidden px-0 sm:px-2";
const showSm = "hidden sm:inline";

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
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card className="@container">
        <CardContent>
          <Table aria-label="Ignored Observables" className="@2xl:table-fixed">
            {/* Set widths, so the value takes what's left and the columns hold still as the list changes. */}
            <colgroup>
              <col />
              <col className="@2xl:w-28 @7xl:w-[8.75%]" />
              <col className="@2xl:w-44 @7xl:w-[13.75%]" />
              <col className="@2xl:w-32 @7xl:w-[10%]" />
              <col className="@2xl:w-28" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Value</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className={fromSm}><span className={showSm}>Added by</span></TableHead>
                <TableHead>Added</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows?.map((e) => (
                <TableRow key={`${e.kind}:${e.id}`}>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">
                    <AccountHoverCard assetId={e.id} account={e.value} enabled={e.kind === "asset" && e.type === "account"}>
                      <ObservableMenu observable={e.kind === "observable" ? { type: e.type as ObservableType, value: e.value } : null}>
                        <ItemLink kind={e.kind} id={e.id} className="hover:underline" title={e.value}>
                          {shown(e)}
                        </ItemLink>
                      </ObservableMenu>
                    </AccountHoverCard>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{typeLabel(e)}</TableCell>
                  <TableCell className={cn(fromSm, "truncate")} title={e.by.name}>
                    <span className={showSm}>{e.by.name}</span>
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground">
                    <Time iso={e.at} />
                  </TableCell>
                  <TableCell className="text-right">
                    {admin && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Stop ignoring ${e.value}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(e)}
                    >
                      Remove
                    </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows?.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {list.data?.length ? "Nothing ignored matches." : "Nothing is ignored."}
                  </TableCell>
                </TableRow>
              )}
              {list.isPending && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5}>
                    <Skeleton className="h-8" />
                    <span className="sr-only" role="status">Loading…</span>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {list.isError && <p className="pt-2 text-sm text-destructive">{list.error.message}</p>}
        </CardContent>
      </Card>
    </>
  );
}
