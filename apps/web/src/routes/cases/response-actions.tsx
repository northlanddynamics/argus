import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ItemLink } from "@/components/item-link";
import { Visibility } from "@/components/visibility";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type ObservableType, observableTypeLabel, shownObservable } from "@/lib/observables";
import {
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  dismissResponseAction,
  type IgnoredInSend,
  type RelyingCases,
  removeResponseAction,
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
import { caseRef, type Severity, severityLabel } from "@/lib/cases";

type Eligible = { id: string; name: string };
type Sendable = { id: string; type: ObservableType; value: string };

/** The Amber Notice treatment (DESIGN.md): the one warning style. */
const notice = "border-notice-border bg-notice text-notice-foreground *:data-[slot=alert-description]:text-notice-foreground/80";

/** Where the Response Actions card sits, for "Show" in the toast after a send. */
const CARD_ID = "response-actions";

/** Whether Falcon takes this Observable as a custom IOC. */
export const falconTakes = (type: ObservableType, value: string) => falconIocType(type, value) !== null;

const labelOf = (o: Sendable) => `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`;
/** The whole value, defanged where that applies: hashes in full, never shortened. */
const fullValue = (o: Sendable) => (["md5", "sha1", "sha256"].includes(o.type) ? o.value : shownObservable(o.type, o.value));

/** States in which a Response Action still holds its value in the tool, or is about to. */
const HOLDING = new Set<ResponseAction["state"]>(["pending", "active", "removing"]);

/** This Case's Response Actions on Observable `id` that still hold it in an Integration. */
export const holdingOn = (held: readonly ResponseAction[], id: string) => held.filter((r) => r.observable.id === id && HOLDING.has(r.state));

/** A time a person can read, with the exact time for pointer and assistive tech alike. */
function At({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={exactTime(iso)}>
      {when(iso)}
    </time>
  );
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * "Send to Falcon": sends one or several Observables on the Case to CrowdStrike Integrations as
 * custom IOCs, one per Observable per Integration. With several Integrations none is ticked to
 * start with, so where it goes is a choice. Before sending it says, per Observable, what is already
 * held from this Case and what will go; one already held on every ticked Integration is left out.
 * Detect, or Prevent for hashes only; severity follows the Case. Ignored Observables need
 * confirming first.
 */
export function SendToFalconDialog({
  number,
  severity,
  observables,
  integrations,
  held,
  trigger,
  onSent,
}: {
  number: number;
  /** The Case's Severity, which the IOC is sent with. */
  severity: Severity;
  observables: Sendable[];
  integrations: Eligible[];
  /** The Case's Response Actions, to say what is already sent. */
  held: readonly ResponseAction[];
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

  const nameOf = (id: string) => integrations.find((i) => i.id === id)?.name ?? "";
  const chosenNames = integrationIds.map(nameOf);

  /** Where each Observable stands: what this Case already holds on the ticked Integrations. */
  const plan = observables.map((o) => {
    const iocType = falconIocType(o.type, o.value);
    const holding = holdingOn(held, o.id).filter((r) => r.integration && integrationIds.includes(r.integration.id));
    const heldOn = [...new Set(holding.map((r) => r.integration!.id))];
    const all = integrationIds.length > 0 && heldOn.length === integrationIds.length;
    let status: { text: string; sends: boolean };
    if (iocType === null) status = { text: `Skipped: Falcon takes no custom IOC for ${observableTypeLabel[o.type]}`, sends: false };
    else if (action === "prevent" && !falconAllowsPrevent(iocType)) status = { text: "Skipped: Falcon can only Detect a domain or IP", sends: false };
    else if (all) {
      const actions = list([...new Set(holding.map((r) => (r.falcon ? falconIocActionLabel[r.falcon.action] : "")).filter(Boolean))]);
      status = { text: `Already sent from this Case${actions ? ` as ${actions}` : ""} to ${list(heldOn.map(nameOf))}; left out`, sends: false };
    } else if (heldOn.length) {
      const rest = integrationIds.filter((id) => !heldOn.includes(id));
      status = { text: `Already sent from this Case to ${list(heldOn.map(nameOf))}; will be sent to ${list(rest.map(nameOf))} only`, sends: true };
    } else status = { text: integrationIds.length ? `Will be sent to ${list(chosenNames)}` : "Will be sent", sends: true };
    return { o, heldOn, status };
  });
  const sends = plan.filter((p) => p.status.sends).length;
  /**
   * One send per ticked Integration, each leaving out what this Case already holds there, so nothing
   * is recorded twice. Those already done (before an Ignored confirmation stopped the rest) aren't
   * sent again.
   */
  const [done, setDone] = useState<string[]>([]);
  const batches = integrationIds
    .filter((id) => !done.includes(id))
    .map((id) => ({ id, observableIds: plan.filter((p) => !p.heldOn.includes(id)).map((p) => p.o.id) }))
    .filter((b) => b.observableIds.length > 0);

  const prevents = observables.some((o) => {
    const t = falconIocType(o.type, o.value);
    return t !== null && falconAllowsPrevent(t);
  });
  const single = observables.length === 1 ? observables[0]! : null;

  const take = useMutation({
    mutationFn: async () => {
      let taken = 0;
      const skipped = new Map<string, SkippedInSend>();
      for (const b of batches) {
        const outcome = await takeResponseActions(number, { observableIds: b.observableIds, integrationIds: [b.id], action, internal, confirmIgnored });
        if ("ignored" in outcome) return outcome;
        taken += outcome.taken;
        for (const sk of outcome.skipped) skipped.set(sk.observable.id, sk);
        setDone((d) => [...d, b.id]);
      }
      return { taken, skipped: [...skipped.values()] };
    },
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
        if (outcome.taken > 0) {
          announce(outcome.taken, chosenNames);
          onSent?.();
        }
      }
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["cases", number] }),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (integrationIds.length && sends > 0 && (!ignored.length || confirmIgnored)) take.mutate();
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
          // With one Integration there is nothing to choose; with several, the Member picks.
          setIntegrationIds(integrations.length === 1 ? [integrations[0]!.id] : []);
          setAction("detect");
          setInternal(false);
          setIgnored([]);
          setConfirmIgnored(false);
          setResult(null);
          setDone([]);
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
            added to Falcon globally, for every platform, as Severity {severityLabel[severity]} (from{" "}
            <span className="font-mono">{caseRef(number)}</span>) with a link back to the Case.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-4">
            <p className="text-sm" role="status">
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
            {integrations.length > 1 ? (
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
            ) : (
              integrations[0] && (
                <p className="text-sm">
                  Sends to <span className="font-medium">{integrations[0].name}</span>.
                </p>
              )
            )}
            <FieldSet>
              <FieldLegend variant="label">Action</FieldLegend>
              <RadioGroup name="action" value={action} onValueChange={(v) => setAction(v as FalconIocAction)}>
                {(["detect", "prevent"] as const).map((a) => (
                  <FieldLabel key={a} htmlFor={`response-action-${a}`}>
                    <Field orientation="horizontal" data-disabled={a === "prevent" && !prevents ? true : undefined}>
                      <RadioGroupItem value={a} id={`response-action-${a}`} disabled={a === "prevent" && !prevents} />
                      <FieldContent>
                        <FieldTitle>{falconIocActionLabel[a]}</FieldTitle>
                        <FieldDescription>
                          {a === "detect"
                            ? "Falcon raises a detection when it sees it. Nothing is blocked."
                            : prevents
                              ? "Falcon blocks the file from running on every host, and raises a detection."
                              : "For hashes only: Falcon can only Detect a domain or IP."}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
            </FieldSet>
            <ul className="grid max-h-48 gap-1.5 overflow-y-auto text-sm" aria-label="Observables to send">
              {plan.map(({ o, status }) => (
                <li key={o.id}>
                  <span className="block font-mono text-xs break-all">{labelOf(o)}</span>
                  <span className={status.sends ? "block text-xs text-muted-foreground" : "block text-xs text-muted-foreground line-through decoration-muted-foreground/40"}>
                    {status.text}
                  </span>
                </li>
              ))}
            </ul>
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id="response-action-internal" checked={internal} onCheckedChange={(checked) => setInternal(checked === true)} />
              <FieldLabel htmlFor="response-action-internal">Internal (hidden from Guests)</FieldLabel>
            </Field>
            {ignored.length > 0 && (
              <Alert className={notice}>
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
            {integrations.length > 1 && integrationIds.length === 0 && <p className="text-xs text-muted-foreground">Tick at least one Integration.</p>}
            {integrationIds.length > 0 && sends === 0 && <p className="text-xs text-muted-foreground">Nothing here is left to send.</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!integrationIds.length || sends === 0 || (ignored.length > 0 && !confirmIgnored) || take.isPending}>
                Send to Falcon
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Says a send went through, and offers the way to the rows it added. */
function announce(taken: number, names: string[]) {
  toast(`${taken} Response Action${taken === 1 ? "" : "s"} taken through ${list(names)}`, {
    description: "Pending until Falcon confirms; shown under Response Actions.",
    action: { label: "Show", onClick: () => document.getElementById(CARD_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }) },
  });
}

/** How heavy each state's badge is: Failed asks for attention, Active is quiet (never "in force"). */
const stateVariant = { pending: "secondary", active: "outline", removing: "secondary", failed: "destructive", removed: "outline" } as const;

const dismissed = (r: ResponseAction) => r.state === "removed" && !!r.dismissedBy;
const stateLabel = (r: ResponseAction) => (dismissed(r) ? "Dismissed" : responseActionStateLabel[r.state]);

/** Where it stands, said as what Argus did: never that something is in force now. */
function StateLine({ r }: { r: ResponseAction }) {
  if (r.state === "removed" && r.dismissedBy && r.dismissedAt) {
    return (
      <span>
        Dismissed by {r.dismissedBy.name} <At iso={r.dismissedAt} />; left unchanged in Falcon
      </span>
    );
  }
  if (r.state === "active" && r.sentAt) {
    return (
      <span>
        Sent <At iso={r.sentAt} />
      </span>
    );
  }
  if (r.state === "pending") return <span>{r.lastError ? "Retrying" : "Waiting to be sent"}</span>;
  if (r.state === "removing") {
    return (
      <span>
        {r.lastError ? "Retrying removal" : "Waiting to be removed"}
        {r.removalRequestedBy && `, asked for by ${r.removalRequestedBy.name}`}
      </span>
    );
  }
  if (r.state === "removed") {
    return (
      <span>
        Removed <At iso={r.stateChangedAt} />
        {r.origin === "created" && r.removalRequestedBy && `, asked for by ${r.removalRequestedBy.name}`}
      </span>
    );
  }
  if (r.state === "active") return null;
  return (
    <span>
      {r.removalRequestedAt ? "Removal failed" : "Failed"} <At iso={r.stateChangedAt} />
    </span>
  );
}

/** Where an "already present" record came from: the Case it was sent from (unless hidden), or the tool. */
function OriginLine({ r, number }: { r: ResponseAction; number: number }) {
  if (r.origin === "already_present" && r.presentFrom) {
    const from = r.presentFrom.case;
    return (
      <span>
        Already present (sent from{" "}
        {from && from.number === number ? (
          "this Case"
        ) : from ? (
          <Link to="/cases/$number" params={{ number: String(from.number) }} className="font-mono underline" title={from.title}>
            {caseRef(from.number)}
            <span className="sr-only"> {from.title}</span>
          </Link>
        ) : (
          "another Case"
        )}{" "}
        <At iso={r.presentFrom.at} />)
      </span>
    );
  }
  if (r.origin === "in_tool") return <span>Already present in Falcon; Argus left it unchanged</span>;
  return null;
}

/**
 * "Remove": asks before Argus deletes what it created in the tool. When other Cases rely on it, says
 * which (those the viewer can see, and how many others) and needs a second confirmation.
 */
function RemoveDialog({ number, r }: { number: number; r: ResponseAction }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [relying, setRelying] = useState<RelyingCases | null>(null);
  const remove = useMutation({
    mutationFn: () => removeResponseAction(number, r.id, relying !== null),
    onSuccess: (outcome) => {
      if ("relying" in outcome) setRelying(outcome.relying);
      else setIsOpen(false);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const count = relying ? relying.cases.length + relying.otherCases : 0;
  const stops = r.falcon?.action === "prevent" ? "Falcon stops blocking and detecting it." : "Falcon stops detecting it.";
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        setIsOpen(next);
        if (next) {
          setRelying(null);
          remove.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Remove the Response Action on ${r.observable.value}`}>
          Remove
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove from Falcon</DialogTitle>
          <DialogDescription>
            Argus deletes the custom IOC for {observableTypeLabel[r.observable.type]}{" "}
            <span className="font-mono break-all">{fullValue(r.observable)}</span>
            {r.integration && ` from ${r.integration.name}`}. {stops} This Case keeps the record, marked Removed.
          </DialogDescription>
        </DialogHeader>
        {relying && (
          <Alert className={notice}>
            <AlertDescription className="grid gap-2">
              <span>
                {count === 1 ? "Another Case relies" : `${count} other Cases rely`} on this custom IOC. Removing it marks their Response Actions
                Removed too:
              </span>
              <ul className="grid gap-0.5">
                {relying.cases.map((c) => (
                  <li key={c.number}>
                    <Link to="/cases/$number" params={{ number: String(c.number) }} className="font-mono underline">
                      {caseRef(c.number)}
                    </Link>{" "}
                    {c.title}
                  </li>
                ))}
                {relying.otherCases > 0 && (
                  <li>
                    {relying.otherCases} {relying.otherCases === 1 ? "Case" : "Cases"} you can't see
                  </li>
                )}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {remove.error && (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {relying ? "Remove anyway" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Dismiss": this Case stops recording an already present IOC as its own; the tool is left alone. */
function DismissDialog({ r, disabled, onDismiss }: { r: ResponseAction; disabled: boolean; onDismiss: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={`Dismiss the record of ${r.observable.value}`}>
          Dismiss
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Dismiss this record?</AlertDialogTitle>
          <AlertDialogDescription>
            This Case stops recording {observableTypeLabel[r.observable.type]}{" "}
            <span className="font-mono break-all">{fullValue(r.observable)}</span> as already present
            {r.integration ? ` in ${r.integration.name}` : ""}. Nothing changes in Falcon, and the record stays here, marked Dismissed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDismiss}>Dismiss</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Failed ones first, since they need someone; then the rest grouped by Observable, in the order they
 * were taken. Removed and dismissed ones go last, folded away.
 */
function arrange(all: readonly ResponseAction[]) {
  const order = new Map(all.map((r, i) => [r.id, i]));
  const firstOf = new Map<string, number>();
  for (const r of all) if (!firstOf.has(r.observable.id)) firstOf.set(r.observable.id, order.get(r.id)!);
  const byObservable = (a: ResponseAction, b: ResponseAction) =>
    firstOf.get(a.observable.id)! - firstOf.get(b.observable.id)! || order.get(a.id)! - order.get(b.id)!;
  return {
    failed: all.filter((r) => r.state === "failed").toSorted(byObservable),
    open: all.filter((r) => r.state !== "failed" && r.state !== "removed").toSorted(byObservable),
    closed: all.filter((r) => r.state === "removed").toSorted(byObservable),
  };
}

/** Case · the Response Actions taken from it, with their state and, for Failed ones, the error and Retry. */
export function ResponseActionsCard({
  number,
  readOnly,
  canRemove,
  canMarkInternal,
}: {
  number: number;
  readOnly: boolean;
  /** Remove what the Case created, and retry a failed removal: on a Closed Case, Admins still can. */
  canRemove: boolean;
  canMarkInternal: boolean;
}) {
  const queryClient = useQueryClient();
  const query = useQuery(responseActionsQuery(number));
  const [showClosed, setShowClosed] = useState(false);
  const retry = useMutation({
    mutationFn: (id: string) => retryResponseAction(number, id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissResponseAction(number, id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const all = query.data?.responseActions ?? [];
  const eligible = query.data?.integrations ?? [];
  const { failed, open, closed } = arrange(all);
  const rows = [...failed, ...open, ...(showClosed ? closed : [])];
  const hasActions = !readOnly || canRemove;
  const columns = 4 + (canMarkInternal ? 1 : 0) + (hasActions ? 1 : 0);
  /** The error of a Retry or Dismiss on row `id`, shown on that row. */
  const errorOn = (id: string) => (retry.variables === id && retry.error) || (dismiss.variables === id && dismiss.error) || null;

  const description = readOnly
    ? "What Argus sent to your security tools from this Case."
    : eligible.length > 0
      ? "What Argus sent to your security tools from this Case. Send an Observable from its row above, or tick several and send them together."
      : "What Argus sent to your security tools from this Case. No Integration takes Response Actions right now: an Admin turns them on under Settings · Integrations.";

  return (
    <Card id={CARD_ID} className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Response Actions</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {query.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>Couldn't load the Response Actions. They're unchanged in your tools.</span>
              <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Table aria-label="Response Actions">
            <TableHeader>
              <TableRow>
                <TableHead>Observable</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Taken by</TableHead>
                {canMarkInternal && <TableHead>Visibility</TableHead>}
                {hasActions && (
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody aria-live="polite" aria-busy={query.isPending}>
              {query.isPending &&
                [0, 1].map((k) => (
                  <TableRow key={k}>
                    <TableCell colSpan={columns}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {rows.map((r) => {
                const error = errorOn(r.id);
                return (
                  <TableRow key={r.id} data-testid={`response-action-${r.observable.value}`} className={r.state === "removed" ? "text-muted-foreground" : undefined}>
                    <TableCell className="min-w-52 whitespace-normal">
                      <ItemLink kind="observable" id={r.observable.id} className="block font-mono text-xs break-all hover:underline" title={r.observable.value}>
                        {shownObservable(r.observable.type, r.observable.value)}
                      </ItemLink>
                      <span className="text-xs text-muted-foreground">{observableTypeLabel[r.observable.type]}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {r.falcon ? falconIocActionLabel[r.falcon.action] : responseActionKindLabel[r.kind]}
                      <span className="block text-xs text-muted-foreground">
                        {r.integration ? r.integration.name : responseActionKindLabel[r.kind]}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge variant={stateVariant[r.state]} className={r.state === "removed" ? "text-muted-foreground" : undefined}>
                        {stateLabel(r)}
                      </Badge>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        <StateLine r={r} />
                      </span>
                      {r.origin !== "created" && (
                        <span className="mt-1 block text-xs text-muted-foreground">
                          <OriginLine r={r} number={number} />
                        </span>
                      )}
                      {r.lastError && <span className="mt-1 block text-xs break-words text-destructive">{r.lastError}</span>}
                    </TableCell>
                    <TableCell className="min-w-28 text-xs whitespace-normal">
                      {r.requestedBy.name}
                      <span className="block text-muted-foreground">
                        <At iso={r.requestedAt} />
                      </span>
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
                    {hasActions && (
                      <TableCell className="w-0 text-right">
                        <div className="flex flex-col items-end gap-1">
                          {r.state === "active" && r.origin === "created" && canRemove && <RemoveDialog number={number} r={r} />}
                          {r.state === "failed" && (r.removalRequestedAt ? canRemove : !readOnly) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={retry.isPending && retry.variables === r.id}
                              aria-label={`Retry the Response Action on ${r.observable.value}`}
                              onClick={() => retry.mutate(r.id)}
                            >
                              Retry
                            </Button>
                          )}
                          {r.state === "active" && r.origin !== "created" && !readOnly && (
                            <DismissDialog r={r} disabled={dismiss.isPending && dismiss.variables === r.id} onDismiss={() => dismiss.mutate(r.id)} />
                          )}
                          {error && (
                            <span role="alert" className="max-w-48 text-left text-xs whitespace-normal text-destructive">
                              {error.message}
                            </span>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {query.isSuccess && all.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns} className="text-muted-foreground">
                    No Response Actions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {closed.length > 0 && (
          <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={showClosed} onClick={() => setShowClosed((s) => !s)}>
            {showClosed ? "Hide" : "Show"} {closed.length} removed or dismissed
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
