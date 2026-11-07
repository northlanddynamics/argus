import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellOffIcon, type LucideIcon, MonitorIcon, SirenIcon, UserIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { ItemLink } from "@/components/item-link";
import { observableIcon } from "@/components/search/search-hit";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { caseQuery, caseRef, isReadOnly } from "@/lib/cases";
import {
  ASSET_TYPES,
  type AssetType,
  assetTypeLabel,
  assetsKey,
  assetsQuery,
  defang,
  normaliseObservable,
  OBSERVABLE_TYPES,
  type ItemKind,
  type ObservableType,
  observableTypeLabel,
  observablesKey,
  observablesQuery,
} from "@/lib/observables";
import { responseActionsQuery } from "@/lib/response-actions";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { actionOf, type ResponseAction } from "@/lib/response-actions";
import { falconTakes, holdingOn, ResponseActionsCard } from "@/routes/cases/response-actions";
import { AssetActions, BulkObservableActions, ObservableActions } from "@/routes/cases/observable-actions";
import { type CaseAsset, HostFalcon } from "@/routes/cases/host-falcon";
import { InternalBadge } from "@/components/visibility";
import { exactTime, when } from "@/lib/when";

/**
 * Case · Observables & Assets, each with the other Cases it also appears in, and the Response
 * Actions taken from the Case.
 */
export function CaseObservablesPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const observables = useQuery(observablesQuery(number));
  const assets = useQuery(assetsQuery(number));
  const responseActions = useQuery(responseActionsQuery(number));
  const [selected, setSelected] = useState<string[]>([]);
  if (!c) return null;
  const readOnly = isReadOnly(c);
  const n = String(number);
  const eligible = responseActions.data?.integrations ?? [];
  const canSend = !readOnly && eligible.length > 0;
  const containment = readOnly ? [] : (responseActions.data?.containment ?? []);
  const held = responseActions.data?.responseActions ?? [];
  // Only what is still linked, and a tool takes, counts as selected.
  const takes = (o: { type: ObservableType; value: string }) => falconTakes(o.type, o.value) || (o.type === "email" && eligible.some((i) => i.provider === "mimecast"));
  const chosen = (observables.data ?? []).filter((o) => selected.includes(o.id) && takes(o));
  return (
    <div className="grid gap-4">
      {/* Observables get the full width: their rows carry what was sent, and Send beside Unlink. */}
      <div className="grid gap-4">
        <LinkedCard<ObservableType>
          title="Observables"
          noun="Observable"
          kind="observable"
          caseNumber={number}
          valueHeading="Value"
          placeholder="185.220.101.4, invoice-portal[.]biz, a hash…"
          types={OBSERVABLE_TYPES}
          typeLabel={observableTypeLabel}
          shown={(type, value) => defang(type, value)}
          items={observables.data}
          query={observables}
          detectType={detectObservableType}
          fullValue={(type, value) => defang(type, value)}
          queryKey={observablesKey(number)}
          readOnly={readOnly}
          add={(type, value) => api.cases[":number"].observables.$post({ param: { number: n }, json: { type, value } })}
          unlink={(id) => api.cases[":number"].observables[":id"].$delete({ param: { number: n, id } })}
          status={{ heading: "Sent from this Case", render: (item) => <SentLine held={holdingOn(held, item.id)} /> }}
          typeIcon={(type) => observableIcon[type]}
          renderRow={(item, row, unlink) => (
            <ObservableActions
              key={item.id}
              number={number}
              observable={item}
              onUnlink={readOnly ? undefined : unlink}
            >
              {row}
            </ObservableActions>
          )}
          selection={
            canSend ? { selected: chosen.map((o) => o.id), onChange: setSelected, selectable: takes } : undefined
          }
          headerAction={
            canSend && chosen.length > 0 ? (
              <BulkObservableActions
                number={number}
                severity={c.severity}
                observables={chosen}
                integrations={eligible}
                held={held}
                onSent={() => setSelected([])}
              />
            ) : null
          }
        />
        <LinkedCard<AssetType>
          title="Assets"
          noun="Asset"
          kind="asset"
          caseNumber={number}
          valueHeading="Identifier"
          placeholder="FIN-LT-0231, d.howe…"
          types={ASSET_TYPES}
          typeLabel={assetTypeLabel}
          shown={(_, value) => value}
          items={assets.data}
          query={assets}
          fullValue={(_, value) => value}
          typeIcon={(type) => (type === "host" ? MonitorIcon : UserIcon)}
          queryKey={assetsKey(number)}
          readOnly={readOnly}
          add={(type, value) => api.cases[":number"].assets.$post({ param: { number: n }, json: { type, value } })}
          unlink={(id) => api.cases[":number"].assets[":id"].$delete({ param: { number: n, id } })}
          status={
            (assets.data ?? []).some((a) => a.type === "host")
              ? { heading: "Falcon", render: (item) => <HostFalcon falcon={item.falcon} />, width: "min-w-60 max-w-72" }
              : undefined
          }
          renderRow={(item, row, unlink) => (
            <AssetActions
              key={item.id}
              number={number}
              asset={item}
              label={`${assetTypeLabel[item.type]} ${item.value}`}
              onUnlink={readOnly ? undefined : unlink}
              canMarkInternal={!readOnly && c.can.markInternal}
              containment={item.type === "host" ? containment : []}
              canLiftContainment={c.can.liftForeignContainment}
            >
              {row}
            </AssetActions>
          )}
        />
      </div>
      <ResponseActionsCard
        number={number}
        readOnly={readOnly}
        canRemove={c.can.work && (c.status !== "closed" || c.can.reopen)}
        canMarkInternal={c.can.markInternal}
      />
    </div>
  );
}

type Item<Type extends string> = {
  id: string;
  type: Type;
  value: string;
  linkedBy: { name: string };
  linkedAt: string;
  seenIn: { number: number; title: string }[];
  fromAlert: { alert: { id: string; externalId: string; title: string } | null } | null;
  ignored: boolean;
  /** Its link to this Case is hidden from Guests. Members only ever see it set. */
  internal: boolean;
  /** A host's Enrichment; empty for everything else. */
  falcon: CaseAsset["falcon"];
};

/**
 * The Observable type a pasted value is, when it isn't valid for the type chosen: a hash pasted while
 * IP is chosen switches to its hash type. Null when the chosen type fits, or no type does.
 */
function detectObservableType(current: ObservableType, raw: string): ObservableType | null {
  const value = raw.trim();
  if (!value || normaliseObservable(current, value)) return null;
  return OBSERVABLE_TYPES.find((t) => normaliseObservable(t, value)) ?? null;
}

function LinkedCard<Type extends string>(props: {
  title: string;
  noun: string;
  /** Whose page each value opens. */
  kind: ItemKind;
  /** The Case these are on, which each value's page leads back to. */
  caseNumber: number;
  valueHeading: string;
  placeholder: string;
  types: readonly Type[];
  typeLabel: Record<Type, string>;
  shown: (type: Type, value: string) => string;
  items: Item<Type>[] | null | undefined;
  /** Where the items stand while they load, or if they can't. */
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  /** The type a typed or pasted value is, when the chosen type doesn't fit it. */
  detectType?: (current: Type, value: string) => Type | null;
  /** Its whole value as it is safe to say, for screen readers where the list shortens it. */
  fullValue: (type: Type, value: string) => string;
  queryKey: readonly unknown[];
  readOnly: boolean;
  add: (type: Type, value: string) => Promise<Response>;
  unlink: (id: string) => Promise<Response>;
  /** A column saying where each item stands, such as what was sent from it. */
  status?: { heading: string; render: (item: Item<Type>) => ReactNode; /** The column's width; `max-w-48` unless given. */ width?: string };
  /** The icon for each type, standing in for its name. */
  typeIcon: (type: Type) => LucideIcon;
  /**
   * Gives the row a menu: `row` renders it with the menu's ⋯ button in place of Unlink, and `unlink`
   * unlinks the item, for the menu to offer.
   */
  renderRow?: (item: Item<Type>, row: (menuButton: ReactNode) => ReactElement, unlink: () => void) => ReactElement;
  /** Set when items can be ticked to act on several at once. */
  selection?: { selected: string[]; onChange: (ids: string[]) => void; selectable?: (item: Item<Type>) => boolean };
  /** Shown beside the title, such as what to do with the ticked items. */
  headerAction?: ReactNode;
}) {
  const { title, noun, types, typeLabel, shown, items, queryKey, readOnly, selection } = props;
  const canTick = (i: Item<Type>) => !selection?.selectable || selection.selectable(i);
  const tickable = (items ?? []).filter(canTick);
  const allSelected = !!tickable.length && !!selection && tickable.every((i) => selection.selected.includes(i.id));
  const queryClient = useQueryClient();
  const [type, setType] = useState<Type>(types[0] as Type);
  const [value, setValue] = useState("");
  const errorId = useId();

  const refresh = () => void queryClient.invalidateQueries({ queryKey });
  const add = useMutation({
    mutationFn: async () => {
      const res = await props.add(type, value);
      if (!res.ok) throw new Error(await errorMessage(res, `Could not add the ${noun}`));
    },
    onSuccess: () => setValue(""),
    onSettled: refresh,
  });
  const unlink = useMutation({
    mutationFn: async (item: Item<Type>) => {
      const res = await props.unlink(item.id);
      if (!res.ok) throw new Error(await errorMessage(res, `Could not unlink the ${noun}`));
    },
    // Unlinking is one click, so it can be undone: linking it again, as whoever undoes it.
    onSuccess: (_, item) =>
      toast(`Unlinked ${typeLabel[item.type]} ${props.fullValue(item.type, item.value)}`, {
        action: {
          label: "Link again",
          onClick: () =>
            void props.add(item.type, item.value).then(async (res) => {
              if (!res.ok) toast.error(await errorMessage(res, `Could not link the ${noun} again`));
              refresh();
            }),
        },
      }),
    onSettled: refresh,
  });
  const addError = add.error;
  const colSpan = 6 + (props.status ? 1 : 0) + (readOnly && !props.renderRow ? 0 : 1) + (selection ? 1 : 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {props.headerAction}
      </CardHeader>
      <CardContent className="grid gap-4">
        {!readOnly && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) add.mutate();
            }}
          >
            <Select value={type} onValueChange={(next) => setType(next as Type)}>
              <SelectTrigger aria-label={`${noun} type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {typeLabel[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label={`${noun} ${props.valueHeading.toLowerCase()}`}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? errorId : undefined}
              className="min-w-40 flex-1 font-mono"
              placeholder={props.placeholder}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (add.error) add.reset();
                const detected = props.detectType?.(type, e.target.value);
                if (detected) setType(detected);
              }}
            />
            <Button type="submit" variant="outline" disabled={add.isPending || !value.trim()}>
              + Add {noun}
            </Button>
          </form>
        )}
        {addError && (
          <Alert variant="destructive" id={errorId}>
            <AlertDescription>{addError.message}</AlertDescription>
          </Alert>
        )}
        {unlink.error && (
          <Alert variant="destructive">
            <AlertDescription>{unlink.error.message}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              {selection && (
                <TableHead className="w-0">
                  <Checkbox
                    aria-label={`Select every ${noun}`}
                    checked={allSelected ? true : selection.selected.length ? "indeterminate" : false}
                    disabled={!tickable.length}
                    onCheckedChange={(checked) => selection.onChange(checked === true ? tickable.map((i) => i.id) : [])}
                  />
                </TableHead>
              )}
              <TableHead className="w-0">
                <span className="sr-only">Type</span>
              </TableHead>
              <TableHead>{props.valueHeading}</TableHead>
              <TableHead className="hidden md:table-cell">Added by</TableHead>
              <TableHead className="hidden md:table-cell">Seen in other Cases</TableHead>
              {props.status && <TableHead className="hidden lg:table-cell">{props.status.heading}</TableHead>}
              <TableHead className="hidden text-right lg:table-cell">Added</TableHead>
              {(!readOnly || props.renderRow) && (
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items?.map((item) => {
              const Icon = props.typeIcon(item.type);
              const row = (menuButton?: ReactNode) => (
                <TableRow key={item.id} data-testid={`${noun.toLowerCase()}-${item.value}`}>
                  {selection && (
                    <TableCell className="w-0">
                      {canTick(item) && (
                        <Checkbox
                          aria-label={`Select ${typeLabel[item.type]} ${item.value}`}
                          checked={selection.selected.includes(item.id)}
                          onCheckedChange={(checked) =>
                            selection.onChange(checked === true ? [...selection.selected, item.id] : selection.selected.filter((id) => id !== item.id))
                          }
                        />
                      )}
                    </TableCell>
                  )}
                  <TableCell className="w-0 pr-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex size-6 items-center justify-center text-muted-foreground">
                          <Icon className="size-4" aria-label={typeLabel[item.type]} role="img" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{typeLabel[item.type]}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  {/* The value takes the room that is left, cut short with … when it doesn't fit; its page shows it whole. */}
                  <TableCell className="w-full max-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <ItemLink
                        kind={props.kind}
                        id={item.id}
                        fromCase={props.caseNumber}
                        className="min-w-0 truncate font-mono text-xs hover:underline"
                        title={props.fullValue(item.type, item.value)}
                        aria-label={`${typeLabel[item.type]} ${props.fullValue(item.type, item.value)}`}
                      >
                        {shown(item.type, item.value)}
                      </ItemLink>
                      {item.ignored && (
                        <Badge variant="outline" className="shrink-0" title="On the Ignored list: it never suggests which Case an Alert belongs with">
                          <BellOffIcon aria-hidden />
                          Ignored
                        </Badge>
                      )}
                      {item.internal && <InternalBadge />}
                    </span>
                  </TableCell>
                  <TableCell className="hidden max-w-48 truncate text-muted-foreground md:table-cell">
                    {item.fromAlert ? (
                      <span className="inline-flex max-w-full items-center gap-1.5" title={item.fromAlert.alert?.title ?? "Added when an Alert was attached"}>
                        <SirenIcon className="size-3.5 shrink-0" aria-hidden />
                        <span className="sr-only">Alert (auto):</span>
                        {item.fromAlert.alert ? (
                          <Link
                            to="/alerts"
                            search={{ status: "any", alert: item.fromAlert.alert.id }}
                            className="truncate text-foreground underline underline-offset-2"
                          >
                            {item.fromAlert.alert.title}
                          </Link>
                        ) : (
                          <span className="truncate">An Alert</span>
                        )}
                      </span>
                    ) : (
                      item.linkedBy.name
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {item.seenIn.length === 0 ? <span className="text-muted-foreground">—</span> : <SeenIn seenIn={item.seenIn} />}
                  </TableCell>
                  {props.status && <TableCell className={`hidden whitespace-normal lg:table-cell ${props.status.width ?? "max-w-48"}`}>{props.status.render(item)}</TableCell>}
                  <TableCell className="hidden text-right text-muted-foreground tabular-nums lg:table-cell" title={exactTime(item.linkedAt)}>
                    {when(item.linkedAt)}
                  </TableCell>
                  {menuButton ? (
                    <TableCell className="w-0 text-right">{menuButton}</TableCell>
                  ) : (
                    !readOnly && (
                      <TableCell className="w-0 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          disabled={unlink.isPending}
                          aria-label={`Unlink ${typeLabel[item.type]} ${item.value}`}
                          onClick={() => unlink.mutate(item)}
                        >
                          Unlink
                        </Button>
                      </TableCell>
                    )
                  )}
                </TableRow>
              );
              return props.renderRow ? props.renderRow(item, row, () => unlink.mutate(item)) : row();
            })}
            {items === undefined && props.query.isPending &&
              [0, 1].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={colSpan}>
                    <Skeleton className="h-8" />
                  </TableCell>
                </TableRow>
              ))}
            {items === undefined && props.query.isError && (
              <TableRow>
                <TableCell colSpan={colSpan} className="whitespace-normal">
                  <span className="text-destructive">Could not load the {title}.</span>{" "}
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void props.query.refetch()}>
                    Try again
                  </Button>
                </TableCell>
              </TableRow>
            )}
            {items?.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-muted-foreground">
                  No {title} yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The other Cases an item is on, each a link to that Case. */
function SeenIn({ seenIn }: { seenIn: { number: number; title: string }[] }) {
  return (
    <span className="font-mono text-xs">
      {seenIn.map((s, i) => (
        <span key={s.number}>
          {i > 0 && ", "}
          <Link
            to="/cases/$number"
            params={{ number: String(s.number) }}
            className="text-foreground underline underline-offset-2"
            title={s.title}
            aria-label={`${caseRef(s.number)} ${s.title}`}
          >
            {caseRef(s.number)}
          </Link>
        </span>
      ))}
    </span>
  );
}

/** An Observable's cell: what this Case has sent of it, per Integration, said as what Argus did. */
function SentLine({ held }: { held: ResponseAction[] }) {
  if (!held.length) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" aria-label="Sent from this Case">
      {held.map((r) => {
        const where =
          r.state === "pending"
            ? "waiting to be sent"
            : r.state === "removing"
              ? "being removed"
              : r.origin === "created" && r.sentAt
                ? `sent ${when(r.sentAt)}`
                : "already present";
        const text = `${actionOf(r)}${r.integration ? ` · ${r.integration.name}` : ""}, ${where}`;
        return (
          <li key={r.id} className="truncate" title={text}>
            {text}
          </li>
        );
      })}
    </ul>
  );
}
