import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { ItemLink } from "@/components/item-link";
import { Visibility } from "@/components/visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ObservableType, observableTypeLabel, shownObservable } from "@/lib/observables";
import {
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  dismissResponseAction,
  type IgnoredInSend,
  type ResponseAction,
  responseActionKindLabel,
  responseActionsKey,
  responseActionsQuery,
  responseActionStateLabel,
  retryResponseAction,
  type SkippedInSend,
  takeResponseActions,
} from "@/lib/response-actions";
import { exactTime, when } from "@/lib/when";
import { caseRef } from "@/lib/cases";

type Eligible = { id: string; name: string };
type Sendable = { id: string; type: ObservableType; value: string };

/** Whether Falcon takes this Observable as a custom IOC. */
export const falconTakes = (type: ObservableType, value: string) => falconIocType(type, value) !== null;

const labelOf = (o: Sendable) => `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`;

/**
 * "Send to Falcon": sends one or several Observables on the Case to CrowdStrike Integrations as
 * custom IOCs, one per Observable per Integration. With several Integrations, all are ticked to
 * start with. Detect, or Prevent for hashes only; severity follows the Case. Observables Falcon
 * doesn't take are skipped and listed; Ignored ones need confirming first.
 */
export function SendToFalconDialog({
  number,
  observables,
  integrations,
  trigger,
  onSent,
}: {
  number: number;
  observables: Sendable[];
  integrations: Eligible[];
  /** Opens the dialog. */
  trigger: ReactNode;
  /** Called once something was sent. */
  onSent?: () => void;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [integrationIds, setIntegrationIds] = useState<string[]>([]);
  const [action, setAction] = useState<FalconIocAction>("detect");
  const [internal, setInternal] = useState(false);
  /** Ignored Observables the API asked to confirm, and whether the Member has. */
  const [ignored, setIgnored] = useState<IgnoredInSend[]>([]);
  const [confirmIgnored, setConfirmIgnored] = useState(false);
  /** What a send that skipped some Observables did, kept on screen until closed. */
  const [result, setResult] = useState<{ taken: number; skipped: SkippedInSend[] } | null>(null);

  const hashes = observables.filter((o) => {
    const t = falconIocType(o.type, o.value);
    return t !== null && falconAllowsPrevent(t);
  });
  const detectOnly = observables.filter((o) => {
    const t = falconIocType(o.type, o.value);
    return t !== null && !falconAllowsPrevent(t);
  });
  const notTaken = observables.filter((o) => !falconTakes(o.type, o.value));
  const prevents = hashes.length > 0;
  const single = observables.length === 1 ? observables[0]! : null;

  const take = useMutation({
    mutationFn: () =>
      takeResponseActions(number, { observableIds: observables.map((o) => o.id), integrationIds, action, internal, confirmIgnored }),
    onSuccess: (outcome) => {
      if ("ignored" in outcome) {
        setIgnored(outcome.ignored);
        setConfirmIgnored(false);
        return;
      }
      // What was skipped stays on screen until closed; the caller hears of the send once it is.
      if (outcome.skipped.length > 0) setResult(outcome);
      else {
        setIsOpen(false);
        if (outcome.taken > 0) onSent?.();
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["cases", number] }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (integrationIds.length && (!ignored.length || confirmIgnored)) take.mutate();
  };
  const close = () => {
    setIsOpen(false);
    if (result && result.taken > 0) onSent?.();
  };
  const toggleIntegration = (id: string, on: boolean) =>
    setIntegrationIds((ids) => (on ? integrations.map((i) => i.id).filter((x) => x === id || ids.includes(x)) : ids.filter((x) => x !== id)));

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) return close();
        setIsOpen(next);
        if (next) {
          setIntegrationIds(integrations.map((i) => i.id));
          setAction("detect");
          setInternal(false);
          setIgnored([]);
          setConfirmIgnored(false);
          setResult(null);
          take.reset();
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to Falcon as a custom IOC</DialogTitle>
          <DialogDescription>
            {single ? (
              <>
                <span className="font-mono break-all">{labelOf(single)}</span> is
              </>
            ) : (
              <>{observables.length} Observables are</>
            )}{" "}
            added to Falcon for every platform, with severity taken from the Case and a link back to it.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-4">
            <p className="text-sm">
              {result.taken === 0 ? "Nothing was sent." : `${result.taken} Response Action${result.taken === 1 ? "" : "s"} taken.`}{" "}
              {result.skipped.length} skipped:
            </p>
            <ul className="grid gap-1 text-sm" aria-label="Skipped">
              {result.skipped.map((s) => (
                <li key={s.observable.id}>
                  <span className="font-mono text-xs break-all">{labelOf(s.observable)}</span>
                  <span className="block text-xs text-muted-foreground">{s.reason}</span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={() => close()}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={onSubmit}>
            {!single && (
              <ul className="grid max-h-40 gap-1 overflow-y-auto text-xs" aria-label="Observables to send">
                {observables.map((o) => (
                  <li key={o.id} className="font-mono break-all">
                    {labelOf(o)}
                  </li>
                ))}
              </ul>
            )}
            {integrations.length > 1 && (
              <FieldSet>
                <FieldLegend variant="label">Integrations</FieldLegend>
                <FieldDescription>One Response Action is taken per Observable for each ticked Integration.</FieldDescription>
                {integrations.map((i) => (
                  <Field key={i.id} orientation="horizontal" className="w-auto">
                    <Checkbox
                      id={`response-action-integration-${i.id}`}
                      checked={integrationIds.includes(i.id)}
                      onCheckedChange={(checked) => toggleIntegration(i.id, checked === true)}
                    />
                    <FieldLabel htmlFor={`response-action-integration-${i.id}`}>{i.name}</FieldLabel>
                  </Field>
                ))}
              </FieldSet>
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
              {action === "prevent" && detectOnly.length > 0 && (
                <FieldDescription>
                  {detectOnly.length} domain{detectOnly.length === 1 ? " or IP" : "s or IPs"} will be skipped: Falcon can only Detect them. Send
                  them separately as Detect.
                </FieldDescription>
              )}
            </FieldSet>
            {notTaken.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {notTaken.length} will be skipped: Falcon takes no custom IOC for{" "}
                {[...new Set(notTaken.map((o) => observableTypeLabel[o.type]))].join(", ")}.
              </p>
            )}
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id="response-action-internal" checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
              <FieldLabel htmlFor="response-action-internal">Internal (hidden from Guests)</FieldLabel>
            </Field>
            {ignored.length > 0 && (
              <Alert>
                <AlertDescription className="grid gap-2">
                  <span>
                    {ignored.length === 1 ? "This Observable is" : "These Observables are"} on the Organization's Ignored list, as too common to
                    mean anything:
                  </span>
                  <ul className="grid gap-0.5">
                    {ignored.map((o) => (
                      <li key={o.id} className="font-mono text-xs break-all">
                        {labelOf(o)}
                      </li>
                    ))}
                  </ul>
                  <Field orientation="horizontal" className="w-auto">
                    <Checkbox id="response-action-confirm-ignored" checked={confirmIgnored} onCheckedChange={(checked) => setConfirmIgnored(checked === true)} />
                    <FieldLabel htmlFor="response-action-confirm-ignored">Send {ignored.length === 1 ? "it" : "them"} anyway</FieldLabel>
                  </Field>
                </AlertDescription>
              </Alert>
            )}
            {take.error && (
              <Alert variant="destructive">
                <AlertDescription>{take.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!integrationIds.length || (ignored.length > 0 && !confirmIgnored) || take.isPending}>
                Send to Falcon
              </Button>
            </DialogFooter>
          </form>
        )}
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
        <CardDescription>
          What Argus sent to your security tools from this Case. Send an Observable from its row above, or tick several and send them together.
        </CardDescription>
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
