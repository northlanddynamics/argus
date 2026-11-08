import { ObservableMenu } from "@/components/observable-menu";
import { PageHeader } from "@/components/page-header";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Time } from "@/components/time";
import { ItemLink } from "@/components/item-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveStatus } from "@/lib/live";
import {
  type AssetType,
  assetTypeLabel,
  defang,
  type IgnoredEntry,
  ignoredQuery,
  itemPagesKey,
  type ObservableType,
  observableTypeLabel,
  setIgnored,
} from "@/lib/observables";

const typeLabel = (e: IgnoredEntry) =>
  e.kind === "observable" ? observableTypeLabel[e.type as ObservableType] : assetTypeLabel[e.type as AssetType];
const shown = (e: IgnoredEntry) => (e.kind === "observable" ? defang(e.type as ObservableType, e.value) : e.value);

/**
 * Settings · Ignored Observables: the Observables and Assets on the Organization's Ignored list,
 * newest first, each with who added it. Items are added from their own page; here they're removed.
 */
/** The Added by column: shown from `sm`; below it its cells stay in the row, emptied, so the columns keep their widths. */
const fromSm = "overflow-hidden px-0 sm:px-2";
const showSm = "hidden sm:inline";

export function IgnoredObservablesPage() {
  const queryClient = useQueryClient();
  const list = useQuery(ignoredQuery);
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
      <PageHeader
        title="Ignored Observables"
        description="Values too common to mean anything, such as public resolvers or your own mail domain. They stay linked and searchable, but never suggest which Case an Alert belongs with. Add one from its page."
      />
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
              <col className="@2xl:w-28" />
              <col className="@2xl:w-44" />
              <col className="@2xl:w-32" />
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
              {list.data?.map((e) => (
                <TableRow key={`${e.kind}:${e.id}`}>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">
                    <ObservableMenu observable={e.kind === "observable" ? { type: e.type as ObservableType, value: e.value } : null}>
                      <ItemLink kind={e.kind} id={e.id} className="hover:underline" title={e.value}>
                        {shown(e)}
                      </ItemLink>
                    </ObservableMenu>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{typeLabel(e)}</TableCell>
                  <TableCell className={cn(fromSm, "truncate")} title={e.by.name}>
                    <span className={showSm}>{e.by.name}</span>
                  </TableCell>
                  <TableCell className="truncate text-muted-foreground">
                    <Time iso={e.at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Stop ignoring ${e.value}`}
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(e)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {list.data?.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="text-muted-foreground">
                    Nothing is ignored.
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
