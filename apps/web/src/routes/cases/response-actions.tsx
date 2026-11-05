import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ItemLink } from "@/components/item-link";
import { Visibility } from "@/components/visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ObservableType, observableTypeLabel, shownObservable } from "@/lib/observables";
import {
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  dismissResponseAction,
  type ResponseAction,
  responseActionKindLabel,
  responseActionsKey,
  responseActionsQuery,
  responseActionStateLabel,
  retryResponseAction,
  takeResponseAction,
} from "@/lib/response-actions";
import { exactTime, when } from "@/lib/when";
import { caseRef } from "@/lib/cases";

type Eligible = { id: string; name: string };

/** Whether Falcon takes this Observable as a custom IOC. */
export const falconTakes = (type: ObservableType, value: string) => falconIocType(type, value) !== null;

/**
 * "Send to Falcon": sends one Observable on the Case to a CrowdStrike Integration as a custom IOC.
 * Detect, or Prevent for hashes only; severity follows the Case.
 */
export function SendToFalconDialog({
  number,
  observable,
  integrations,
}: {
  number: number;
  observable: { id: string; type: ObservableType; value: string };
  integrations: Eligible[];
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [integrationId, setIntegrationId] = useState(integrations[0]?.id ?? "");
  const [action, setAction] = useState<FalconIocAction>("detect");
  const [internal, setInternal] = useState(false);
  const iocType = falconIocType(observable.type, observable.value);
  const prevents = iocType !== null && falconAllowsPrevent(iocType);

  const take = useMutation({
    mutationFn: () => takeResponseAction(number, { observableId: observable.id, integrationId, action, internal }),
    onSuccess: () => setIsOpen(false),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["cases", number] }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (integrationId) take.mutate();
  };
  const label = `${observableTypeLabel[observable.type]} ${shownObservable(observable.type, observable.value)}`;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) {
          setIntegrationId(integrations[0]?.id ?? "");
          setAction("detect");
          setInternal(false);
          take.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2" aria-label={`Send ${observableTypeLabel[observable.type]} ${observable.value} to Falcon`}>
          Send to Falcon
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to Falcon as a custom IOC</DialogTitle>
          <DialogDescription>
            <span className="font-mono break-all">{label}</span> is added to Falcon for every platform, with its severity taken from
            the Case and a link back to it.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          {integrations.length > 1 && (
            <Field>
              <FieldLabel htmlFor="response-action-integration">Integration</FieldLabel>
              <NativeSelect id="response-action-integration" value={integrationId} onChange={(e) => setIntegrationId(e.target.value)}>
                {integrations.map((i) => (
                  <NativeSelectOption key={i.id} value={i.id}>
                    {i.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <FieldSet>
            <FieldLegend variant="label">Action</FieldLegend>
            <RadioGroup name="action" value={action} onValueChange={(v) => setAction(v as FalconIocAction)} className="sm:grid-cols-2">
              {(["detect", "prevent"] as const).map((a) => (
                <FieldLabel key={a} htmlFor={`response-action-${a}`}>
                  <Field orientation="horizontal" data-disabled={a === "prevent" && !prevents ? true : undefined}>
                    <RadioGroupItem value={a} id={`response-action-${a}`} disabled={a === "prevent" && !prevents} />
                    <FieldTitle>{falconIocActionLabel[a]}</FieldTitle>
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
            {!prevents && <FieldDescription>Falcon can only Detect a domain or IP; Prevent is for hashes.</FieldDescription>}
          </FieldSet>
          <Field orientation="horizontal" className="w-auto">
            <Checkbox id="response-action-internal" checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
            <FieldLabel htmlFor="response-action-internal">Internal (hidden from Guests)</FieldLabel>
          </Field>
          {take.error && (
            <Alert variant="destructive">
              <AlertDescription>{take.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!integrationId || take.isPending}>
              Send to Falcon
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const stateVariant = { pending: "secondary", active: "default", failed: "destructive", removed: "outline" } as const;

/** Where it stands, said as what Argus did: never that something is in force now. */
function StateLine({ r }: { r: ResponseAction }) {
  if (r.state === "removed" && r.dismissedBy && r.dismissedAt) {
    return <span title={exactTime(r.dismissedAt)}>Dismissed by {r.dismissedBy.name} {when(r.dismissedAt)}</span>;
  }
  if (r.state === "active" && r.sentAt) {
    return <span title={exactTime(r.sentAt)}>Sent {when(r.sentAt)}</span>;
  }
  if (r.state === "pending") return <span>{r.lastError ? "Retrying" : "Waiting to be sent"}</span>;
  if (r.state === "active") return null;
  return <span title={exactTime(r.stateChangedAt)}>Failed {when(r.stateChangedAt)}</span>;
}

/** Where an "already present" record came from: the Case it was sent from (unless hidden), or the tool. */
function OriginLine({ r }: { r: ResponseAction }) {
  if (r.origin === "already_present" && r.presentFrom) {
    const from = r.presentFrom.case;
    return (
      <span title={exactTime(r.presentFrom.at)}>
        Already present (sent from{" "}
        {from ? (
          <Link to="/cases/$number" params={{ number: String(from.number) }} className="underline" title={from.title}>
            {caseRef(from.number)}
          </Link>
        ) : (
          "another Case"
        )}{" "}
        {when(r.presentFrom.at)})
      </span>
    );
  }
  if (r.origin === "in_tool") return <span>Already present in Falcon; Argus left it unchanged</span>;
  return null;
}

/** Case · the Response Actions taken from it, with their state and, for Failed ones, the error and Retry. */
export function ResponseActionsCard({ number, readOnly, canMarkInternal }: { number: number; readOnly: boolean; canMarkInternal: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery(responseActionsQuery(number));
  const retry = useMutation({
    mutationFn: (id: string) => retryResponseAction(number, id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissResponseAction(number, id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const list = data?.responseActions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Response Actions</CardTitle>
        <CardDescription>What Argus sent to your security tools from this Case. Send an Observable from its row above.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {(retry.error ?? dismiss.error) && (
          <Alert variant="destructive">
            <AlertDescription>{(retry.error ?? dismiss.error)!.message}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Observable</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Taken by</TableHead>
              {canMarkInternal && <TableHead>Visibility</TableHead>}
              {!readOnly && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((r) => (
              <TableRow key={r.id} data-testid={`response-action-${r.observable.value}`}>
                <TableCell className="min-w-36 whitespace-normal">
                  <ItemLink kind="observable" id={r.observable.id} className="block font-mono text-xs break-all hover:underline" title={r.observable.value}>
                    {shownObservable(r.observable.type, r.observable.value)}
                  </ItemLink>
                  <span className="text-xs text-muted-foreground">{observableTypeLabel[r.observable.type]}</span>
                </TableCell>
                <TableCell className="whitespace-normal">
                  {responseActionKindLabel[r.kind]}
                  {r.falcon && (
                    <span className="block text-xs text-muted-foreground">
                      {falconIocActionLabel[r.falcon.action]}
                      {r.integration && ` · ${r.integration.name}`}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Badge variant={stateVariant[r.state]}>{responseActionStateLabel[r.state]}</Badge>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    <StateLine r={r} />
                  </span>
                  {r.origin !== "created" && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      <OriginLine r={r} />
                    </span>
                  )}
                  {r.lastError && <span className="mt-1 block text-xs break-words text-destructive">{r.lastError}</span>}
                </TableCell>
                <TableCell className="text-xs whitespace-normal" title={exactTime(r.requestedAt)}>
                  {r.requestedBy.name}
                  <span className="block text-muted-foreground">{when(r.requestedAt)}</span>
                </TableCell>
                {canMarkInternal && (
                  <TableCell>
                    <Visibility
                      number={number}
                      item={{ kind: "response_action", id: r.id }}
                      internal={r.internal}
                      label={`Response Action on ${r.observable.value}`}
                      canMark={!readOnly}
                    />
                  </TableCell>
                )}
                {!readOnly && (
                  <TableCell className="w-0 text-right">
                    {r.state === "failed" && (
                      <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate(r.id)}>
                        Retry
                      </Button>
                    )}
                    {r.state === "active" && r.origin !== "created" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dismiss.isPending}
                        onClick={() => dismiss.mutate(r.id)}
                        title="This Case stops claiming it; nothing is changed in the tool"
                      >
                        Dismiss
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
            {list.length === 0 && (
              <TableRow>
                <TableCell colSpan={4 + (canMarkInternal ? 1 : 0) + (readOnly ? 0 : 1)} className="text-muted-foreground">
                  No Response Actions yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
