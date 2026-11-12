import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { BellOffIcon, StarIcon } from "lucide-react";
import { Time } from "@/components/time";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveStatus } from "@/lib/live";
import { cn } from "@/lib/utils";
import { OBSERVABLE_TYPES, observableListQuery, observableTypeLabel, tickedTypes } from "@/lib/observables";
import { ItemRow } from "@/routes/observables/item-row";

const cases = (n: number) => (n === 0 ? "On no Case" : n === 1 ? "1 Case" : `${n} Cases`);

/**
 * The Observables tab: every Observable the Organization holds, newest first, of the ticked types
 * and containing the value searched for, as search results show them: with how many Cases each is
 * on, whether it is Important or Ignored, and when it was first seen.
 */
export function ObservablesTab() {
  const { q = "", types } = useSearch({ from: "/_app/observables" });
  const ticked = tickedTypes(types);
  const observableTypes = OBSERVABLE_TYPES.filter((t) => ticked.has(t));
  // Only Asset types ticked, as when coming from the Ignored tab: no Observable is of them.
  const none = ticked.size > 0 && observableTypes.length === 0;
  // The last results stay, faded, while the next load, so the list doesn't jump as you type.
  const list = useQuery({ ...observableListQuery(q, observableTypes), enabled: !none, placeholderData: keepPreviousData });
  useLiveStatus();
  const rows = none ? [] : list.data?.observables;

  return (
    <div className="grid grid-cols-1 gap-3">
      {!none && list.isPending && (
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
            ? q || ticked.size
              ? "No Observable matches."
              : "The Organization holds no Observables yet."
            : list.data?.more
              ? `The newest ${rows.length}. Search or pick types to find others.`
              : `${rows.length} ${rows.length === 1 ? "Observable" : "Observables"}, newest first`}
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul aria-label="Observables" className={cn("divide-y overflow-hidden rounded-lg border", list.isPlaceholderData && "opacity-60 transition-opacity")}>
          {rows.map((o) => (
            <ItemRow
              key={o.id}
              kind="observable"
              id={o.id}
              type={o.type}
              value={o.value}
              query={q}
              detail={
                <>
                  {o.ignored && (
                    <>
                      <BellOffIcon className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                      Ignored ·{" "}
                    </>
                  )}
                  {observableTypeLabel[o.type]} · {cases(o.cases)}
                </>
              }
              aside={
                <>
                  {o.important && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <StarIcon className="size-3 fill-current" aria-hidden />
                      <span className="hidden sm:inline">Important</span>
                      <span className="sr-only sm:hidden">Important</span>
                    </span>
                  )}
                  <Time iso={o.firstSeen} className="hidden w-24 text-right text-xs text-muted-foreground sm:inline" />
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}
