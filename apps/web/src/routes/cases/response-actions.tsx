import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ObservableHoverCard } from "@/components/observable-details";
import { ObservableMenu } from "@/components/observable-menu";
import { type FormEvent, Fragment, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CaseRef } from "@/components/case-ref";
import { Time } from "@/components/time";
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
  actionOf,
  dismissResponseAction,
  describeDefaults,
  type EligibleIntegration,
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  type IgnoredInSend,
  type RelyingCases,
  removeResponseAction,
  type ResponseAction,
  responseActionKindLabel,
  responseActionsKey,
  responseActionsQuery,
  responseActionStateLabel,
  retryResponseAction,
  subjectOf,
  type SkippedInSend,
  takeResponseActions,
  toolOf,
} from "@/lib/response-actions";
import { caseRef, type Severity } from "@/lib/cases";
import { ObservableActions } from "@/routes/cases/observable-actions";

type Eligible = Pick<EligibleIntegration, "id" | "name" | "defaults">;
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
export const holdingOn = (held: readonly ResponseAction[], id: string) => held.filter((r) => r.observable?.id === id && HOLDING.has(r.state));

/** Where the IOC goes and with what: one Integration's defaults, or each Integration's own. */
function sentWith(integrations: readonly Eligible[], severity: Severity) {
  const [only] = integrations;
  if (integrations.length === 1 && only) return `${describeDefaults(only.defaults, severity)}`;
  return "with each Integration's severity and platforms";
}

/** Whether a send starts Internal: so when every Integration it goes to says so by default. */
export const startsInternal = (integrations: readonly Eligible[]) => integrations.length > 0 && integrations.every((i) => i.defaults.internal);

/** A time a person can read, with the full time on hover and copying on right-click. */
const At = ({ iso }: { iso: string }) => <Time iso={iso} />;

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
  defaultOpen = false,
  onClose,
  onSent,
}: {
  number: number;
  /** The Case's Severity, which the IOC is sent with. */
  severity: Severity;
  observables: Sendable[];
  integrations: Eligible[];
  /** The Case's Response Actions, to say what is already sent. */
  held: readonly ResponseAction[];
  /** Opens the dialog; left out, the dialog opens when mounted (`defaultOpen`), as from a menu. */
  trigger?: ReactNode;
  /** Open as soon as it is mounted. */
  defaultOpen?: boolean;
  /** Called whenever it closes. */
  onClose?: () => void;
  /** Called once something was sent. */
  onSent?: () => void;
}) {
  const queryClient = useQueryClient();
  const [isOpen, setOpenState] = useState(defaultOpen);
  const setIsOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) onClose?.();
  };
  /** With one Integration there is nothing to choose; with several, the Member picks. */
  const initialIds = () => (integrations.length === 1 ? [integrations[0]!.id] : []);
  const [integrationIds, setIntegrationIds] = useState<string[]>(initialIds);
  const [action, setAction] = useState<FalconIocAction>("detect");
  const [internal, setInternal] = useState(() => startsInternal(integrations.filter((i) => initialIds().includes(i.id))));
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
  const toggleIntegration = (id: string, on: boolean) => {
    const ids = on ? integrations.map((i) => i.id).filter((x) => x === id || integrationIds.includes(x)) : integrationIds.filter((x) => x !== id);
    setIntegrationIds(ids);
    setInternal(startsInternal(integrations.filter((i) => ids.includes(i.id))));
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) return close();
        setIsOpen(next);
        if (next) {
          setIntegrationIds(initialIds());
          setAction("detect");
          setInternal(startsInternal(integrations.filter((i) => initialIds().includes(i.id))));
          setIgnored([]);
          setConfirmIgnored(false);
          setResult(null);
          setDone([]);
          take.reset();
        }
      }}
    >
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
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
            added to Falcon globally, {sentWith(integrationIds.length ? integrations.filter((i) => integrationIds.includes(i.id)) : integrations, severity)}, with a
            link back to <span className="font-mono">{caseRef(number)}</span>.
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
              <FieldLabel htmlFor="response-action-internal">Internal</FieldLabel>
            </Field>
            {ignored.length > 0 && (
              <Alert className={notice}>
                <AlertDescription className="grid gap-2">
                  <span>
                    {ignored.length === 1 ? "This Observable is" : "These Observables are"} on the Ignored list:
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
export function announce(taken: number, names: string[]) {
  toast(`${taken} Response Action${taken === 1 ? "" : "s"} taken through ${list(names)}`, {
    description: "Shown under Response Actions.",
    action: { label: "Show", onClick: () => document.getElementById(CARD_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }) },
  });
}

/** How heavy each state's badge is: Failed asks for attention, Active is quiet (never "in force"). */
const stateVariant = { pending: "secondary", active: "outline", removing: "secondary", failed: "destructive", removed: "outline" } as const;

const dismissed = (r: ResponseAction) => r.state === "removed" && !!r.dismissedBy;
const stateLabel = (r: ResponseAction) => (dismissed(r) ? "Dismissed" : responseActionStateLabel[r.state]);

/** Where it stands, said as what Argus did: never that something is in force now. */
function StateLine({ r, number }: { r: ResponseAction; number: number }) {
  if (r.state === "removed" && r.dismissedBy && r.dismissedAt) {
    return (
      <span>
        Dismissed by {r.dismissedBy.name} <At iso={r.dismissedAt} />
      </span>
    );
  }
  if (r.state === "active" && r.sentAt) {
    return (
      <span>
        {r.kind === "falcon_containment_lift" ? "Lifted" : "Sent"} <At iso={r.sentAt} />
      </span>
    );
  }
  if (r.state === "pending") return <span>{r.lastError ? "Retrying" : "Waiting to be sent"}</span>;
  if (r.state === "removing") {
    return (
      <span>
        {r.kind === "falcon_containment" ? (r.lastError ? "Retrying the lift" : "Waiting to be lifted") : r.lastError ? "Retrying removal" : "Waiting to be removed"}
        {r.removalRequestedBy && `, asked for by ${r.removalRequestedBy.name}`}
      </span>
    );
  }
  if (r.state === "removed" && r.liftedBy) {
    const from = r.liftedBy.case;
    return (
      <span>
        Lifted by an Admin from{" "}
        {from && from.number === number ? (
          "this Case"
        ) : from ? (
          <CaseRef number={from.number} title={from.title} />
        ) : (
          "another Case"
        )}{" "}
        <At iso={r.liftedBy.at} />
      </span>
    );
  }
  if (r.state === "removed" && r.liftedInToolAt) {
    return (
      <span>
        Lifted in Falcon <At iso={r.liftedInToolAt} />
      </span>
    );
  }
  if (r.state === "removed") {
    return (
      <span>
        {r.kind === "falcon_containment" && r.origin === "created" && r.removalRequestedBy ? "Lifted" : "Removed"} <At iso={r.stateChangedAt} />
        {r.origin === "created" && r.removalRequestedBy && `, asked for by ${r.removalRequestedBy.name}`}
      </span>
    );
  }
  if (r.state === "active") return null;
  return (
    <span>
      {r.removalRequestedAt ? (r.kind === "falcon_containment" ? "Lift failed" : "Removal failed") : "Failed"} <At iso={r.stateChangedAt} />
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
          <CaseRef number={from.number} title={from.title} />
        ) : (
          "another Case"
        )}{" "}
        <At iso={r.presentFrom.at} />)
      </span>
    );
  }
  if (r.origin === "in_tool") return <span>{r.kind === "falcon_containment_lift" ? "Already released" : "Already present"} in {toolOf(r.kind)}</span>;
  return null;
}

/**
 * "Remove", opened from a menu: asks before Argus deletes what it created in the tool. When other Cases rely on it, says
 * which (those the viewer can see, and how many others) and needs a second confirmation.
 */
export function RemoveDialog({ number, r, onClose }: { number: number; r: ResponseAction; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [isOpen, setOpenState] = useState(true);
  const setIsOpen = (next: boolean) => {
    setOpenState(next);
    if (!next) onClose();
  };
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
  const lifting = r.kind === "falcon_containment";
  const mimecast = r.kind === "mimecast_blocked_sender";
  const stops = mimecast
    ? "Mimecast stops blocking it."
    : r.falcon?.action === "prevent"
      ? "Falcon stops blocking and detecting it."
      : "Falcon stops detecting it.";
  const entry = lifting ? "containment" : mimecast ? "blocked sender entry" : "custom IOC";
  const verb = lifting ? "Lift containment" : "Remove";
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{lifting ? "Lift containment in Falcon" : `Remove from ${toolOf(r.kind)}`}</DialogTitle>
          <DialogDescription>
            {lifting ? (
              <>
                Argus asks Falcon to lift the containment of <SubjectText r={r} />
                {r.integration && ` through ${r.integration.name}`}. The host goes back on the network.
              </>
            ) : (
              <>
                Argus deletes the {entry} for <SubjectText r={r} />
                {r.integration && ` from ${r.integration.name}`}. {stops}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {relying && (
          <Alert className={notice}>
            <AlertDescription className="grid gap-2">
              <span>
                {count === 1 ? "Another Case relies" : `${count} other Cases rely`} on this {entry}. {lifting ? "Lifting" : "Removing"} it marks their
                Response Actions Removed too:
              </span>
              <ul className="grid gap-0.5">
                {relying.cases.map((c) => (
                  <li key={c.number}>
                    <CaseRef number={c.number} title={c.title} />{" "}
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
            {relying ? `${verb} anyway` : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Dismiss", opened from a menu: this Case stops recording an already present IOC or block as its own; the tool is left alone. */
export function DismissDialog({ r, disabled, onDismiss, onClose }: { r: ResponseAction; disabled: boolean; onDismiss: () => void; onClose: () => void }) {
  return (
    <AlertDialog defaultOpen onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Dismiss this record?</AlertDialogTitle>
          <AlertDialogDescription>
            This Case stops recording <SubjectText r={r} /> as already present
            {r.integration ? ` in ${r.integration.name}` : ""}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={disabled} onClick={onDismiss}>
            Dismiss
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "SHA-256 e3b0…" in full, defanged where it could be clicked; "Host FIN-LT-0231 (device 8f1c…)" for containment. */
function SubjectText({ r }: { r: ResponseAction }) {
  if (r.observable) {
    return (
      <>
        {observableTypeLabel[r.observable.type]} <span className="font-mono break-all">{fullValue(r.observable)}</span>
      </>
    );
  }
  return (
    <>
      host <span className="font-mono break-all">{r.asset?.value}</span> (device <span className="font-mono break-all">{r.target.value}</span>)
    </>
  );
}

/**
 * Failed ones first, since they need someone; then the rest grouped by what they were taken against,
 * in the order they were taken. Removed and dismissed ones go last, folded away.
 */
function arrange(all: readonly ResponseAction[]) {
  const order = new Map(all.map((r, i) => [r.id, i]));
  const firstOf = new Map<string, number>();
  for (const r of all) if (!firstOf.has(subjectOf(r).id)) firstOf.set(subjectOf(r).id, order.get(r.id)!);
  const byObservable = (a: ResponseAction, b: ResponseAction) =>
    firstOf.get(subjectOf(a).id)! - firstOf.get(subjectOf(b).id)! || order.get(a.id)! - order.get(b.id)!;
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
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) }),
  });
  const [dismissing, setDismissing] = useState<ResponseAction | null>(null);
  const [lifting, setLifting] = useState<ResponseAction | null>(null);
  const all = query.data?.responseActions ?? [];
  const eligible = query.data?.integrations ?? [];
  const { failed, open, closed } = arrange(all);
  const rows = [...failed, ...open, ...(showClosed ? closed : [])];
  const columns = 6 + (canMarkInternal ? 1 : 0);
  /** The error of a Retry on row `id`, shown on that row. */
  const errorOn = (id: string) => (retry.variables === id && retry.error) || null;

  const containing = query.data?.containment ?? [];
  const description =
    !readOnly && eligible.length === 0 && containing.length === 0 ? "Response Actions are off. An Admin turns them on under Settings · Integrations." : null;

  return (
    <Card id={CARD_ID} className="scroll-mt-16">
      <CardHeader>
        <CardTitle>Response Actions</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
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
          <div className="@container">
          <Table aria-label="Response Actions" className="@4xl:table-fixed">
            {/* Once there's room, set widths, so the columns hold still as Response Actions change state live; the Target takes the rest. */}
            <colgroup>
              <col />
              <col className="@4xl:w-48" />
              <col className="@4xl:w-56" />
              <col className="@4xl:w-36" />
              <col className="@4xl:w-32" />
              {canMarkInternal && <col className="@4xl:w-44" />}
              <col className="@4xl:w-28" />
            </colgroup>
            {/* Column headings only once there is something under them. */}
            <TableHeader className={query.isPending || all.length ? undefined : "sr-only"}>
              <TableRow className="hover:bg-transparent">
                <TableHead>Target</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Taken by</TableHead>
                <TableHead>Taken</TableHead>
                {canMarkInternal && <TableHead>Visibility</TableHead>}
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-live="polite" aria-busy={query.isPending}>
              {query.isPending &&
                [0, 1].map((k) => (
                  <TableRow key={k} className="hover:bg-transparent">
                    <TableCell colSpan={columns}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {rows.map((r) => {
                const error = errorOn(r.id);
                const subject = subjectOf(r);
                const row = (menuButton: ReactNode) => (
                      <TableRow data-testid={`response-action-${subject.value}`} className={r.state === "removed" ? "text-muted-foreground" : undefined}>
                        <TableCell className="min-w-52 whitespace-normal">
                          {r.observable ? (
                            <>
                              <ObservableHoverCard type={r.observable.type} value={r.observable.value}>
                                <ObservableMenu observable={r.observable}>
                                  <ItemLink kind="observable" id={r.observable.id} className="block font-mono text-xs break-all hover:underline" title={r.observable.value}>
                                    {shownObservable(r.observable.type, r.observable.value)}
                                  </ItemLink>
                                </ObservableMenu>
                              </ObservableHoverCard>
                              <span className="text-xs text-muted-foreground">{observableTypeLabel[r.observable.type]}</span>
                            </>
                          ) : (
                            <>
                              <ItemLink kind="asset" id={subject.id} className="block font-mono text-xs break-all hover:underline" title={subject.value}>
                                {subject.value}
                              </ItemLink>
                              <span className="text-xs break-all text-muted-foreground">
                                Host · device <span className="font-mono">{r.target.value}</span>
                              </span>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {actionOf(r)}
                          <span className="block text-xs text-muted-foreground">
                            {r.integration ? r.integration.name : responseActionKindLabel[r.kind]}
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <Badge variant={stateVariant[r.state]} className={r.state === "removed" ? "text-muted-foreground" : undefined}>
                            {stateLabel(r)}
                          </Badge>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            <StateLine r={r} number={number} />
                          </span>
                          {r.origin !== "created" && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              <OriginLine r={r} number={number} />
                            </span>
                          )}
                          {r.lastError && <span className="mt-1 block text-xs break-words text-destructive">{r.lastError}</span>}
                        </TableCell>
                        <TableCell className="truncate" title={r.requestedBy.name}>
                          {r.requestedBy.name}
                        </TableCell>
                        <TableCell className="truncate text-muted-foreground">
                          <At iso={r.requestedAt} />
                        </TableCell>
                        {canMarkInternal && (
                          <TableCell>
                            <Visibility
                              number={number}
                              item={{ kind: "response_action", id: r.id }}
                              internal={r.internal}
                              label={`Response Action on ${subject.value}`}
                              canMark={!readOnly}
                            />
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {/* Failed needs someone, so Retry stays in sight; the rest is in the menu. */}
                            {r.state === "failed" && (r.removalRequestedAt ? canRemove : !readOnly) && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={retry.isPending && retry.variables === r.id}
                                aria-label={`Retry the Response Action on ${subject.value}`}
                                onClick={() => retry.mutate(r.id)}
                              >
                                Retry
                              </Button>
                            )}
                            {/* A host has no Observable menu: an already present containment is dismissed here. */}
                            {!r.observable && !readOnly && r.state === "active" && r.origin !== "created" && r.kind !== "falcon_containment_lift" && (
                              <Button variant="ghost" size="sm" aria-label={`Dismiss the Response Action on ${subject.value}`} onClick={() => setDismissing(r)}>
                                Dismiss
                              </Button>
                            )}
                            {r.kind === "falcon_containment" && canRemove && r.state === "active" && r.origin === "created" && (
                              <Button variant="ghost" size="sm" aria-label={`Lift containment of ${subject.value}`} onClick={() => setLifting(r)}>
                                Lift containment
                              </Button>
                            )}
                            {menuButton}
                          </div>
                          {error && (
                            <span role="alert" className="mt-1 block max-w-48 text-left text-xs whitespace-normal text-destructive">
                              {error.message}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                );
                // Right-click or ⋯ for what can be done with its Observable: Remove, Dismiss, another IOC.
                return r.observable ? (
                  <ObservableActions key={r.id} number={number} observable={r.observable}>
                    {row}
                  </ObservableActions>
                ) : (
                  <Fragment key={r.id}>{row(null)}</Fragment>
                );
              })}
              {query.isSuccess && all.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns} className="text-muted-foreground">
                    No Response Actions yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        )}
        {lifting && <RemoveDialog number={number} r={lifting} onClose={() => setLifting(null)} />}
        {dismissing && (
          <DismissDialog
            r={dismissing}
            disabled={dismiss.isPending}
            onDismiss={() => dismiss.mutate(dismissing.id)}
            onClose={() => setDismissing(null)}
          />
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
