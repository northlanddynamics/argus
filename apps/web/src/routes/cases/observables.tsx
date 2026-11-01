import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/api";
import { caseQuery, caseRef, isReadOnly } from "@/lib/cases";
import { shortHash } from "@/lib/evidence";
import {
  ASSET_TYPES,
  type AssetType,
  assetTypeLabel,
  assetsKey,
  assetsQuery,
  defang,
  OBSERVABLE_TYPES,
  type ObservableType,
  observableTypeLabel,
  observablesKey,
  observablesQuery,
} from "@/lib/observables";
import { useCaseNumber } from "@/routes/cases/case-layout";

/** Case · Observables & Assets, each with the other Cases it also appears in. */
export function CaseObservablesPage() {
  const number = useCaseNumber();
  const { data: c } = useQuery(caseQuery(number));
  const observables = useQuery(observablesQuery(number));
  const assets = useQuery(assetsQuery(number));
  if (!c) return null;
  const readOnly = isReadOnly(c);
  const n = String(number);
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <LinkedCard<ObservableType>
          title="Observables"
          noun="Observable"
          valueHeading="Value"
          placeholder="185.220.101.4, invoice-portal[.]biz, a hash…"
          types={OBSERVABLE_TYPES}
          typeLabel={observableTypeLabel}
          shown={(type, value) => (["md5", "sha1", "sha256"].includes(type) ? shortHash(value) : defang(type, value))}
          items={observables.data}
          queryKey={observablesKey(number)}
          readOnly={readOnly}
          add={(type, value) => api.cases[":number"].observables.$post({ param: { number: n }, json: { type, value } })}
          unlink={(id) => api.cases[":number"].observables[":id"].$delete({ param: { number: n, id } })}
        />
        <LinkedCard<AssetType>
          title="Assets"
          noun="Asset"
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
      <p className="text-xs text-muted-foreground">
        Each Observable and Asset is held once for the Organization. “Seen in other Cases” lists only Cases you can see.
        Adding and unlinking are recorded in the Audit Log.
      </p>
    </>
  );
}

type Item<Type extends string> = {
  id: string;
  type: Type;
  value: string;
  linkedBy: { name: string };
  linkedAt: string;
  seenIn: { number: number; title: string }[];
};

function LinkedCard<Type extends string>(props: {
  title: string;
  noun: string;
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
}) {
  const { title, noun, types, typeLabel, shown, items, queryKey, readOnly } = props;
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
      <CardHeader>
        <CardTitle>{title}</CardTitle>
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
            <NativeSelect aria-label={`${noun} type`} value={type} onChange={(e) => setType(e.target.value as Type)}>
              {types.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {typeLabel[t]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
              <TableHead>Type</TableHead>
              <TableHead>{props.valueHeading}</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead>Seen in other Cases</TableHead>
              {!readOnly && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items?.map((item) => (
              <TableRow key={item.id} data-testid={`${noun.toLowerCase()}-${item.value}`}>
                <TableCell>{typeLabel[item.type] ?? item.type}</TableCell>
                <TableCell className="min-w-36 font-mono text-xs break-all whitespace-normal" title={item.value}>
                  {shown(item.type, item.value)}
                </TableCell>
                <TableCell className="text-sm" title={new Date(item.linkedAt).toLocaleString()}>
                  {item.linkedBy.name}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {item.seenIn.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    item.seenIn.map((s, i) => (
                      <span key={s.number}>
                        {i > 0 && ", "}
                        <Link
                          to="/cases/$number/observables"
                          params={{ number: String(s.number) }}
                          className="text-primary underline"
                          title={s.title}
                        >
                          {caseRef(s.number)}
                        </Link>
                      </span>
                    ))
                  )}
                </TableCell>
                {!readOnly && (
                  <TableCell className="w-0 pl-0 text-right">
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
                <TableCell colSpan={readOnly ? 4 : 5} className="text-muted-foreground">
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
