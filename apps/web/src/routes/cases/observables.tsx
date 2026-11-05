import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ItemLink } from "@/components/item-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  OBSERVABLE_TYPES,
  type ItemKind,
  type ObservableType,
  observableTypeLabel,
  observablesKey,
  observablesQuery,
  shownObservable,
} from "@/lib/observables";
import { responseActionsQuery } from "@/lib/response-actions";
import { useCaseNumber } from "@/routes/cases/case-layout";
import { falconTakes, ResponseActionsCard, SendToFalconDialog } from "@/routes/cases/response-actions";

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
  // Only what is still linked counts as selected.
  const chosen = (observables.data ?? []).filter((o) => selected.includes(o.id));
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <LinkedCard<ObservableType>
          title="Observables"
          noun="Observable"
          kind="observable"
          valueHeading="Value"
          placeholder="185.220.101.4, invoice-portal[.]biz, a hash…"
          types={OBSERVABLE_TYPES}
          typeLabel={observableTypeLabel}
          shown={shownObservable}
          items={observables.data}
          queryKey={observablesKey(number)}
          readOnly={readOnly}
          add={(type, value) => api.cases[":number"].observables.$post({ param: { number: n }, json: { type, value } })}
          unlink={(id) => api.cases[":number"].observables[":id"].$delete({ param: { number: n, id } })}
          renderAction={(item) =>
            eligible.length > 0 && falconTakes(item.type, item.value) ? (
              <SendToFalconDialog
                number={number}
                observables={[item]}
                integrations={eligible}
                trigger={
                  <Button variant="ghost" size="sm" className="px-2" aria-label={`Send ${observableTypeLabel[item.type]} ${item.value} to Falcon`}>
                    Send to Falcon
                  </Button>
                }
              />
            ) : null
          }
          selection={canSend ? { selected: chosen.map((o) => o.id), onChange: setSelected } : undefined}
          headerAction={
            canSend && chosen.length > 0 ? (
              <SendToFalconDialog
                number={number}
                observables={chosen}
                integrations={eligible}
                onSent={() => setSelected([])}
                trigger={<Button size="sm">Send {chosen.length} to Falcon</Button>}
              />
            ) : null
          }
        />
        <LinkedCard<AssetType>
          title="Assets"
          noun="Asset"
          kind="asset"
          valueHeading="Identifier"
          placeholder="FIN-LT-0231, d.howe…"
          types={ASSET_TYPES}
          typeLabel={assetTypeLabel}
          shown={(_, value) => value}
          items={assets.data}
          queryKey={assetsKey(number)}
          readOnly={readOnly}
          add={(type, value) => api.cases[":number"].assets.$post({ param: { number: n }, json: { type, value } })}
          unlink={(id) => api.cases[":number"].assets[":id"].$delete({ param: { number: n, id } })}
        />
      </div>
      <ResponseActionsCard number={number} readOnly={readOnly} canMarkInternal={c.can.markInternal} />
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
};

function LinkedCard<Type extends string>(props: {
  title: string;
  noun: string;
  /** Whose page each value opens. */
  kind: ItemKind;
  valueHeading: string;
  placeholder: string;
  types: readonly Type[];
  typeLabel: Record<Type, string>;
  shown: (type: Type, value: string) => string;
  items: Item<Type>[] | null | undefined;
  queryKey: readonly unknown[];
  readOnly: boolean;
  add: (type: Type, value: string) => Promise<Response>;
  unlink: (id: string) => Promise<Response>;
  /** Something more to do with an item, beside Unlink. */
  renderAction?: (item: Item<Type>) => ReactNode;
  /** Set when items can be ticked to act on several at once. */
  selection?: { selected: string[]; onChange: (ids: string[]) => void };
  /** Shown beside the title, such as what to do with the ticked items. */
  headerAction?: ReactNode;
}) {
  const { title, noun, types, typeLabel, shown, items, queryKey, readOnly, selection } = props;
  const allSelected = !!items?.length && !!selection && items.every((i) => selection.selected.includes(i.id));
  const queryClient = useQueryClient();
  const [type, setType] = useState<Type>(types[0] as Type);
  const [value, setValue] = useState("");

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
    mutationFn: async (id: string) => {
      const res = await props.unlink(id);
      if (!res.ok) throw new Error(await errorMessage(res, `Could not unlink the ${noun}`));
    },
    onSettled: refresh,
  });
  const error = add.error ?? unlink.error;

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
              className="min-w-40 flex-1 font-mono"
              placeholder={props.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={add.isPending || !value.trim()}>
              + Add {noun}
            </Button>
          </form>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
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
                    onCheckedChange={(checked) => selection.onChange(checked === true ? (items ?? []).map((i) => i.id) : [])}
                  />
                </TableHead>
              )}
              <TableHead>Type</TableHead>
              <TableHead>{props.valueHeading}</TableHead>
              <TableHead>Seen in other Cases</TableHead>
              {!readOnly && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items?.map((item) => (
              <TableRow key={item.id} data-testid={`${noun.toLowerCase()}-${item.value}`}>
                {selection && (
                  <TableCell className="w-0">
                    <Checkbox
                      aria-label={`Select ${typeLabel[item.type]} ${item.value}`}
                      checked={selection.selected.includes(item.id)}
                      onCheckedChange={(checked) =>
                        selection.onChange(checked === true ? [...selection.selected, item.id] : selection.selected.filter((id) => id !== item.id))
                      }
                    />
                  </TableCell>
                )}
                <TableCell>{typeLabel[item.type] ?? item.type}</TableCell>
                {/* Who added it sits under the value, so the row fits a half-width card without clipping Unlink. */}
                <TableCell className="min-w-36 whitespace-normal">
                  <ItemLink kind={props.kind} id={item.id} className="block font-mono text-xs break-all hover:underline" title={item.value}>
                    {shown(item.type, item.value)}
                  </ItemLink>
                  <span
                    className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                    title={new Date(item.linkedAt).toLocaleString()}
                  >
                    {item.fromAlert ? (
                      <>
                        <Badge variant="secondary">Alert (auto)</Badge>
                        {item.fromAlert.alert && (
                          <Link
                            to="/alerts"
                            search={{ status: "any", alert: item.fromAlert.alert.id }}
                            className="text-xs text-primary underline"
                            title={item.fromAlert.alert.externalId}
                          >
                            {item.fromAlert.alert.title}
                          </Link>
                        )}
                      </>
                    ) : (
                      <>Added by {item.linkedBy.name}</>
                    )}
                  </span>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {item.seenIn.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    // Each opens the item's own page, which lists every Case and Alert it is on.
                    <ItemLink kind={props.kind} id={item.id} className="text-primary underline" title={item.seenIn.map((s) => `${caseRef(s.number)} ${s.title}`).join("\n")}>
                      {item.seenIn.map((s) => caseRef(s.number)).join(", ")}
                    </ItemLink>
                  )}
                </TableCell>
                {!readOnly && (
                  <TableCell className="w-0 text-right whitespace-nowrap">
                    {props.renderAction?.(item)}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-2"
                      disabled={unlink.isPending}
                      aria-label={`Unlink ${typeLabel[item.type]} ${item.value}`}
                      onClick={() => unlink.mutate(item.id)}
                    >
                      Unlink
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {items?.length === 0 && (
              <TableRow>
                <TableCell colSpan={(readOnly ? 3 : 4) + (selection ? 1 : 0)} className="text-muted-foreground">
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
