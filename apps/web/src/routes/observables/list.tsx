import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { ItemLink } from "@/components/item-link";
import { ObservableMenu } from "@/components/observable-menu";
import { Time } from "@/components/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveStatus } from "@/lib/live";
import { OBSERVABLE_TYPES, type ObservableType, observableListQuery, observableTypeLabel, shownObservable, tickedTypes } from "@/lib/observables";

/**
 * The Observables tab: every Observable the Organization holds, newest first, of the ticked types
 * and containing the value searched for, with how many Cases each is on and whether it is Important
 * or Ignored.
 */
export function ObservablesTab() {
  const { q = "", types } = useSearch({ from: "/_app/observables" });
  const ticked = tickedTypes(types);
  const observableTypes = OBSERVABLE_TYPES.filter((t) => ticked.has(t));
  // Only Asset types ticked, as when coming from the Ignored tab: no Observable is of them.
  const none = ticked.size > 0 && observableTypes.length === 0;
  const list = useQuery({ ...observableListQuery(q, observableTypes), enabled: !none });
  useLiveStatus();
  const rows = none ? [] : list.data?.observables;

  return (
    <Card className="@container">
      <CardContent>
        <Table aria-label="Observables" className="@2xl:table-fixed">
          <colgroup>
            <col />
            <col className="@2xl:w-24" />
            <col className="@2xl:w-20" />
            <col className="@2xl:w-44" />
            <col className="@2xl:w-32" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Value</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Cases</TableHead>
              <TableHead>
                <span className="sr-only">Marks</span>
              </TableHead>
              <TableHead>First seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows?.map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-mono text-xs break-all whitespace-normal">
                  <ObservableMenu observable={{ type: o.type, value: o.value }}>
                    <ItemLink kind="observable" id={o.id} className="hover:underline" title={o.value}>
                      {shownObservable(o.type as ObservableType, o.value)}
                    </ItemLink>
                  </ObservableMenu>
                </TableCell>
                <TableCell className="text-muted-foreground">{observableTypeLabel[o.type as ObservableType]}</TableCell>
                <TableCell className="text-right tabular-nums">{o.cases}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {o.important && <Badge variant="secondary">Important</Badge>}
                    {o.ignored && <Badge variant="outline">Ignored</Badge>}
                  </div>
                </TableCell>
                <TableCell className="truncate text-muted-foreground">
                  <Time iso={o.firstSeen} />
                </TableCell>
              </TableRow>
            ))}
            {rows?.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="text-muted-foreground">
                  {q || ticked.size ? "No Observable matches." : "The Organization holds no Observables yet."}
                </TableCell>
              </TableRow>
            )}
            {!none && list.isPending && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <Skeleton className="h-8" />
                  <span className="sr-only" role="status">
                    Loading…
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {list.data?.more && !none && (
          <p className="pt-2 text-sm text-muted-foreground">Showing the newest {list.data.observables.length}. Search or pick types to find others.</p>
        )}
        {list.isError && <p className="pt-2 text-sm text-destructive">{list.error.message}</p>}
      </CardContent>
    </Card>
  );
}
