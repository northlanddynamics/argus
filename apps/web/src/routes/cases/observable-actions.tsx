import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CopyIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  UnlinkIcon,
  ExternalLinkIcon,
  GlobeLockIcon,
  ListPlusIcon,
  SearchIcon,
  MailXIcon,
  ShieldAlertIcon,
  ShieldBanIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  Undo2Icon,
  WifiIcon,
  WifiOffIcon,
  ZapIcon,
  PanelRightOpenIcon,
} from "lucide-react";
import { type ComponentType, type ReactElement, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { type EnrichableType, hasEnrichment, useEnrichmentPanel } from "@/lib/enrichment";
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
import { ObservableIgnoreItem, useObservableIgnore } from "@/components/observable-ignore";
import { ObservableImportantItem, useObservableImportant } from "@/components/observable-important";
import { ObservableCopyItems, ObservableLookupItems } from "@/components/observable-menu";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { caseQuery, isReadOnly, type Severity } from "@/lib/cases";
import { useMarkInternal } from "@/lib/internal";
import { defang, type ObservableType, observableTypeLabel, shownObservable } from "@/lib/observables";
import {
  type ContainmentIntegration,
  describeDefaults,
  dismissResponseAction,
  type EligibleIntegration,
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  type IgnoredInSend,
  MIMECAST_ACTIONS,
  mimecastTarget,
  UMBRELLA_ACTIONS,
  type ResponseActionAction,
  type ResponseAction,
  responseActionsKey,
  responseActionsQuery,
  retryResponseAction,
  takeResponseActions,
} from "@/lib/response-actions";
import { when } from "@/lib/when";
import { ContainHostDialog } from "@/routes/cases/contain-host-dialog";
import { DismissDialog, holdingOn, RemoveDialog, SendToFalconDialog } from "@/routes/cases/response-actions";

/**
 * "Take action" on an Observable on a Case, from a ⋯ button and from right-clicking wherever the
 * Observable is shown with its Case: one click sends it to an Integration as a Falcon custom IOC
 * alert (Detect) or block (Prevent), with that Integration's defaults (ADR 0008), or blocks an email
 * address or its domain in Mimecast, or adds a domain to an Umbrella destination list; Remove, Retry
 * and Dismiss act on what the Case already sent.
 * "More options…" opens the full Falcon send dialog.
 */

type Sendable = { id: string; type: ObservableType; value: string };
type Destination = Pick<EligibleIntegration, "id" | "name" | "provider" | "defaults" | "destinationList">;

/** What a menu is built from, so the ⋯ menu and the right-click menu hold the same items. */
type ItemProps = { onSelect?: (event: Event) => void; disabled?: boolean; variant?: "default" | "destructive"; className?: string; children: ReactNode };
type MenuKit = {
  Item: ComponentType<ItemProps>;
  Label: ComponentType<{ className?: string; children: ReactNode }>;
  Separator: ComponentType<object>;
  Sub: ComponentType<{ children: ReactNode }>;
  SubTrigger: ComponentType<{ className?: string; children: ReactNode }>;
  SubContent: ComponentType<{ className?: string; children: ReactNode }>;
};
const dropdownKit: MenuKit = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};
const contextKit: MenuKit = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

/** The one-click actions, as the menu names them: Falcon's Detect is an alert, its Prevent a block. */
const quickLabel: Record<ResponseActionAction, string> = {
  detect: "IOC alert",
  prevent: "IOC block",
  block_sender: "Block sender",
  block_domain: "Block domain",
  add_to_destination_list: "Add to destination list",
};
const QuickIcon: Record<ResponseActionAction, ComponentType<{ className?: string }>> = {
  detect: ShieldAlertIcon,
  prevent: ShieldBanIcon,
  block_sender: MailXIcon,
  block_domain: GlobeLockIcon,
  add_to_destination_list: ListPlusIcon,
};
/** Whether a destination is Falcon's: one whose Provider is unknown here was a Falcon one. */
const isFalcon = (d: { provider?: Destination["provider"] }) => d.provider !== "mimecast" && d.provider !== "umbrella";
const FALCON_QUICK = ["detect", "prevent"] as const satisfies readonly FalconIocAction[];

/** The domain of an email address. */
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const labelOf = (o: Sendable) => `${observableTypeLabel[o.type]} ${shownObservable(o.type, o.value)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Two lines in a menu item: what it does, and in smaller type how. */
function Twoline({ title, hint }: { title: ReactNode; hint?: ReactNode }) {
  return (
    <span className="grid min-w-0">
      <span>{title}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </span>
  );
}

/**
 * Sends Observables to one Integration in one click, with its defaults. An Ignored Observable asks
 * first; what Falcon doesn't take is skipped and said so.
 */
function useQuickSend(number: number) {
  const queryClient = useQueryClient();
  type Args = { observables: Sendable[]; to: Pick<Destination, "id" | "name">; action: ResponseActionAction; confirmIgnored?: boolean; onSent?: () => void };
  const [asking, setAsking] = useState<{ args: Args; ignored: IgnoredInSend[] } | null>(null);
  const send = useMutation({
    mutationFn: (args: Args) =>
      takeResponseActions(number, {
        observableIds: args.observables.map((o) => o.id),
        integrationIds: [args.to.id],
        action: args.action,
        confirmIgnored: !!args.confirmIgnored,
      }),
    onSuccess: (outcome, args) => {
      if ("ignored" in outcome) {
        setAsking({ args, ignored: outcome.ignored });
        return;
      }
      setAsking(null);
      const what = args.observables.length === 1 ? labelOf(args.observables[0]!) : plural(outcome.taken, "Observable");
      if (outcome.taken > 0) {
        toast(`${quickLabel[args.action]} sent through ${args.to.name}`, {
          description: what,
        });
        args.onSent?.();
      }
      if (outcome.skipped.length > 0) {
        toast.warning(`${plural(outcome.skipped.length, "Observable")} skipped`, {
          description: outcome.skipped.map((s) => `${labelOf(s.observable)}: ${s.reason}`).join("\n"),
        });
      }
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["cases", number] }),
  });
  const confirm = (
    <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send an Ignored Observable?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">
              <span>
                {asking?.ignored.length === 1 ? "This Observable is" : "These Observables are"} on the Ignored list:
              </span>
              <ul className="grid gap-0.5">
                {asking?.ignored.map((o) => (
                  <li key={o.id} className="font-mono text-xs break-all">
                    {labelOf(o)}
                  </li>
                ))}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => asking && send.mutate({ ...asking.args, confirmIgnored: true })}>Send anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { send: (args: Args) => send.mutate(args), sending: send.isPending, confirm };
}

/** What a Response Action did, as the menu names it: "IOC alert", "Block domain"… */
const quickOf = (r: ResponseAction) =>
  r.falcon
    ? quickLabel[r.falcon.action]
    : r.kind === "mimecast_blocked_sender"
      ? quickLabel[r.target.type === "domain" ? "block_domain" : "block_sender"]
      : r.kind === "umbrella_destination"
        ? `In ${r.destinationList?.name ?? "destination list"}`
        : "IOC";

/** What this Case sent of the Observable through one Integration, said as what Argus did. */
function heldLine(r: ResponseAction) {
  const action = quickOf(r);
  if (r.state === "pending") return `${action}: waiting to be sent`;
  if (r.state === "removing") return `${action}: being removed`;
  if (r.origin === "in_tool") {
    return r.kind === "umbrella_destination"
      ? `${action} in Umbrella already`
      : `${action} in ${r.kind === "mimecast_blocked_sender" ? "Mimecast" : "Falcon"}`;
  }
  const at = r.origin === "already_present" ? r.presentFrom?.at : r.sentAt;
  return at ? `${action} sent ${when(at)}` : `${action} sent`;
}

type Dialog = { kind: "more" } | { kind: "remove"; r: ResponseAction } | { kind: "dismiss"; r: ResponseAction } | null;

/**
 * The ⋯ menu and right-click menu for Observable `observable` on Case `number`. `children` gets the
 * ⋯ button to place and returns the element (such as a table row) that right-click opens the menu
 * on. With `onUnlink`, the menu also unlinks it from the Case.
 */
export function ObservableActions({
  number,
  observable,
  onUnlink,
  children,
}: {
  number: number;
  observable: Sendable;
  onUnlink?: () => void;
  children: (menuButton: ReactNode) => ReactElement;
}) {
  const navigate = useNavigate();
  const enrichment = useEnrichmentPanel();
  const queryClient = useQueryClient();
  // Loaded once a menu opens; on the Case's own pages they are cached already.
  const [wanted, setWanted] = useState(false);
  const caseView = useQuery({ ...caseQuery(number), enabled: wanted });
  const actions = useQuery({ ...responseActionsQuery(number), enabled: wanted });
  const quick = useQuickSend(number);
  const ignore = useObservableIgnore(observable.type, observable.value);
  const important = useObservableImportant(observable.type, observable.value);
  const [dialog, setDialog] = useState<Dialog>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: responseActionsKey(number) });
  const retry = useMutation({ mutationFn: (id: string) => retryResponseAction(number, id), onError: (e) => toast.error(e.message), onSettled: refresh });
  const dismiss = useMutation({ mutationFn: (id: string) => dismissResponseAction(number, id), onError: (e) => toast.error(e.message), onSettled: refresh });

  const c = caseView.data;
  const readOnly = c ? isReadOnly(c) : true;
  const canRemove = !!c && c.can.work && (c.status !== "closed" || c.can.reopen);
  const all = actions.data?.responseActions ?? [];
  const eligible = actions.data?.integrations ?? [];
  const mine = all.filter((r) => r.observable?.id === observable.id);
  const held = holdingOn(all, observable.id);
  const iocType = falconIocType(observable.type, observable.value);
  // The full send dialog is Falcon's.
  const falconEligible = eligible.filter((i) => i.provider === "crowdstrike");

  // Every Integration it can go to, then any it was sent through that no longer takes Response Actions.
  // On a Closed Case nothing new is sent, so only those it already sent through are listed.
  const destinations: {
    id: string;
    name: string;
    provider?: Destination["provider"];
    defaults: Destination["defaults"] | null;
    destinationList?: Destination["destinationList"];
  }[] = readOnly
    ? []
    : [...eligible];
  const actionable = readOnly ? mine.filter((r) => r.state !== "removed") : mine;
  for (const r of actionable) {
    if (r.integration && !destinations.some((d) => d.id === r.integration!.id)) {
      const known = eligible.find((e) => e.id === r.integration!.id);
      destinations.push({ ...r.integration, provider: known?.provider, defaults: known?.defaults ?? null });
    }
  }
  // Umbrella Integrations with Response Actions on but no destination list yet: named, so the menu says why they offer nothing.
  const awaiting = readOnly ? [] : (actions.data?.awaitingList ?? []).filter((a) => !destinations.some((d) => d.id === a.id));
  // Until the menu has loaded, offer it to anyone who might work the Case; once loaded, only if there is something to do.
  const showTakeAction = !c || (c.can.work && (!readOnly || actionable.length > 0));

  const takeActionItems = (kit: MenuKit) => {
    if (caseView.isPending || actions.isPending) return <kit.Item disabled>Loading…</kit.Item>;
    if (actions.isError || caseView.isError) return <kit.Item disabled>Couldn't load the Response Actions</kit.Item>;
    if (destinations.length === 0 && awaiting.length === 0) {
      return (
        <kit.Item disabled>
          <Twoline title="Response Actions are off" hint="An Admin turns them on under Settings · Integrations" />
        </kit.Item>
      );
    }
    return (
      <>
        {destinations.map((d, i) => {
          const live = held.find((r) => r.integration?.id === d.id);
          const failed = mine.findLast((r) => r.integration?.id === d.id && r.state === "failed");
          return (
            <div key={d.id} role="group" aria-label={d.name}>
              {i > 0 && <kit.Separator />}
              <kit.Label className="grid">
                <span>{d.name}</span>
                {d.defaults && describeDefaults(d.defaults, c?.severity, d.provider) && (
                  <span className="text-xs font-normal text-muted-foreground">{describeDefaults(d.defaults, c?.severity, d.provider)}</span>
                )}
              </kit.Label>
              {live ? (
                <>
                  <kit.Item disabled>
                    <ShieldIcon />
                    {heldLine(live)}
                  </kit.Item>
                  {live.state === "active" && live.origin === "created" && canRemove && (
                    <kit.Item variant="destructive" onSelect={() => setDialog({ kind: "remove", r: live })}>
                      <Undo2Icon />
                      <Twoline
                        title={live.kind === "mimecast_blocked_sender" ? "Remove block…" : live.kind === "umbrella_destination" ? "Remove from list…" : "Remove IOC…"}
                        hint={
                          live.kind === "mimecast_blocked_sender"
                            ? "Mimecast stops blocking it"
                            : live.kind === "umbrella_destination"
                              ? `Umbrella's ${live.destinationList?.name ?? "destination list"} no longer holds it`
                              : live.falcon?.action === "prevent"
                              ? "Falcon stops blocking and detecting it"
                              : "Falcon stops detecting it"
                        }
                      />
                    </kit.Item>
                  )}
                  {live.state === "active" && live.origin !== "created" && !readOnly && (
                    <kit.Item onSelect={() => setDialog({ kind: "dismiss", r: live })}>
                      <Undo2Icon />
                      Dismiss record…
                    </kit.Item>
                  )}
                </>
              ) : (
                <>
                  {failed && (failed.removalRequestedAt ? canRemove : !readOnly) && (
                    <kit.Item disabled={retry.isPending} onSelect={() => retry.mutate(failed.id)}>
                      <ZapIcon />
                      <Twoline title={failed.removalRequestedAt ? "Retry removal" : `Retry ${quickOf(failed)}`} hint={failed.lastError ?? "It failed"} />
                    </kit.Item>
                  )}
                  {!failed && d.defaults && !readOnly && d.provider === "mimecast" && observable.type !== "email" && (
                    <kit.Item disabled>Mimecast blocks email senders only</kit.Item>
                  )}
                  {!failed &&
                    d.defaults &&
                    !readOnly &&
                    d.provider === "mimecast" &&
                    observable.type === "email" &&
                    MIMECAST_ACTIONS.map((action) => {
                      const Icon = QuickIcon[action];
                      const target = mimecastTarget("email", observable.value.toLowerCase(), action)!;
                      // The domain is blocked through its own Observable: say so here if this Case already did.
                      const domainHeld =
                        action === "block_domain" &&
                        all.some(
                          (r) =>
                            r.integration?.id === d.id &&
                            r.target.type === "domain" &&
                            r.target.value === domainOf(observable.value) &&
                            ["pending", "active", "removing"].includes(r.state),
                        );
                      return (
                        <kit.Item
                          key={action}
                          disabled={domainHeld || quick.sending}
                          onSelect={() => quick.send({ observables: [observable], to: d, action })}
                        >
                          <Icon />
                          <Twoline
                            title={quickLabel[action]}
                            hint={domainHeld ? `${target.value} is already blocked from this Case` : action === "block_domain" ? `Everyone at ${target.value}` : undefined}
                          />
                        </kit.Item>
                      );
                    })}
                  {!failed && d.defaults && !readOnly && d.provider === "umbrella" && observable.type !== "domain" && (
                    <kit.Item disabled>Umbrella takes domains only</kit.Item>
                  )}
                  {!failed &&
                    d.defaults &&
                    !readOnly &&
                    d.provider === "umbrella" &&
                    observable.type === "domain" &&
                    UMBRELLA_ACTIONS.map((action) => {
                      const Icon = QuickIcon[action];
                      return (
                        <kit.Item key={action} disabled={quick.sending} onSelect={() => quick.send({ observables: [observable], to: d, action })}>
                          <Icon />
                          <Twoline title={quickLabel[action]} hint={d.destinationList ? `${d.destinationList.name} (${d.destinationList.access === "block" ? "Block" : "Allow"})` : undefined} />
                        </kit.Item>
                      );
                    })}
                  {!failed && d.defaults && !readOnly && isFalcon(d) && iocType === null && (
                    <kit.Item disabled>Falcon takes no {observableTypeLabel[observable.type]}</kit.Item>
                  )}
                  {!failed &&
                    d.defaults &&
                    !readOnly &&
                    isFalcon(d) &&
                    iocType !== null &&
                    FALCON_QUICK.map((action) => {
                      const Icon = QuickIcon[action];
                      const allowed = action === "detect" || falconAllowsPrevent(iocType);
                      return (
                        <kit.Item
                          key={action}
                          disabled={!allowed || quick.sending}
                          onSelect={() => quick.send({ observables: [observable], to: d, action })}
                        >
                          <Icon />
                          {quickLabel[action]} ({falconIocActionLabel[action]})
                        </kit.Item>
                      );
                    })}
                  {!d.defaults && !failed && <kit.Item disabled>Response Actions are off for this Integration</kit.Item>}
                </>
              )}
            </div>
          );
        })}
        {awaiting.map((a, i) => (
          <div key={a.id} role="group" aria-label={a.name}>
            {(destinations.length > 0 || i > 0) && <kit.Separator />}
            <kit.Label>{a.name}</kit.Label>
            <kit.Item disabled>
              <Twoline title="No destination list chosen yet" hint="An Admin chooses one under Settings · Integrations" />
            </kit.Item>
          </div>
        ))}
        {!readOnly && falconEligible.length > 0 && iocType !== null && (
          <>
            <kit.Separator />
            <kit.Item onSelect={() => setDialog({ kind: "more" })}>
              <SlidersHorizontalIcon />
              More options…
            </kit.Item>
          </>
        )}
      </>
    );
  };

  const items = (kit: MenuKit) => (
    <>
      {showTakeAction && (
        <>
          <kit.Sub>
            <kit.SubTrigger>
              <ZapIcon />
              Take action
            </kit.SubTrigger>
            <kit.SubContent className="w-72">{takeActionItems(kit)}</kit.SubContent>
          </kit.Sub>
          <kit.Separator />
        </>
      )}
      {enrichment.available && hasEnrichment(observable.type) && (
        <kit.Item onSelect={() => enrichment.open({ type: observable.type as EnrichableType, value: observable.value })}>
          <PanelRightOpenIcon />
          Show Enrichment
        </kit.Item>
      )}
      <kit.Item onSelect={() => void navigate({ to: "/observables/$id", params: { id: observable.id }, search: { from: number } })}>
        <ExternalLinkIcon />
        Open Observable page
      </kit.Item>
      <kit.Item onSelect={() => void navigate({ to: "/search", search: { q: observable.value } })}>
        <SearchIcon />
        Search for this
      </kit.Item>
      <ObservableCopyItems Item={kit.Item} type={observable.type} value={observable.value} />
      <ObservableLookupItems Item={kit.Item} type={observable.type} value={observable.value} />
      {(important.available || ignore.available) && (
        <>
          <kit.Separator />
          <ObservableImportantItem Item={kit.Item} important={important} />
          <ObservableIgnoreItem Item={kit.Item} ignore={ignore} />
        </>
      )}
      {onUnlink && (
        <>
          <kit.Separator />
          <kit.Item variant="destructive" onSelect={onUnlink}>
            <UnlinkIcon />
            Unlink from this Case
          </kit.Item>
        </>
      )}
    </>
  );

  const menuButton = (
    <DropdownMenu onOpenChange={(open) => open && setWanted(true)}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${observableTypeLabel[observable.type]} ${defang(observable.type, observable.value)}`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items(dropdownKit)}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <ContextMenu onOpenChange={(open) => open && setWanted(true)}>
        <ContextMenuTrigger asChild>{children(menuButton)}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">{items(contextKit)}</ContextMenuContent>
      </ContextMenu>
      {quick.confirm}
      {ignore.dialog}
      {dialog?.kind === "more" && c && (
        <SendToFalconDialog
          defaultOpen
          onClose={() => setDialog(null)}
          number={number}
          severity={c.severity}
          observables={[observable]}
          integrations={falconEligible}
          held={all}
        />
      )}
      {dialog?.kind === "remove" && <RemoveDialog onClose={() => setDialog(null)} number={number} r={dialog.r} />}
      {dialog?.kind === "dismiss" && (
        <DismissDialog onClose={() => setDialog(null)} r={dialog.r} disabled={dismiss.isPending} onDismiss={() => dismiss.mutate(dialog.r.id)} />
      )}
    </>
  );
}

/**
 * An Asset's menu on a Case, from a ⋯ button and from right-clicking its row, like an Observable's
 * without "Take action": open its page, search for it, copy it and, with `onUnlink`, unlink it.
 */
export function AssetActions({
  number,
  asset,
  label,
  onUnlink,
  canMarkInternal = false,
  containment = [],
  canLiftContainment = false,
  children,
}: {
  number: number;
  asset: { id: string; value: string; internal: boolean };
  /** For a host on a Case that can be worked: the Integrations it can be contained through (ADR 0009). */
  containment?: ContainmentIntegration[];
  /** Offers lifting containment Argus didn't impose, through `containment`: Admins only. */
  canLiftContainment?: boolean;
  /** Its type and identifier, naming the ⋯ button. */
  label: string;
  onUnlink?: () => void;
  /** Offers marking its link to the Case Internal (hidden from Guests, with its Enrichment), or showing it again. */
  canMarkInternal?: boolean;
  children: (menuButton: ReactNode) => ReactElement;
}) {
  const navigate = useNavigate();
  const copy = () => void navigator.clipboard.writeText(asset.value).then(() => toast("Copied"));
  const mark = useMarkInternal(number);
  const [containing, setContaining] = useState<"contain" | "lift" | null>(null);
  const setInternal = (internal: boolean, undoable = true) =>
    mark.mutate(
      { item: { kind: "asset", id: asset.id }, internal },
      {
        onSuccess: () => {
          if (!undoable) return;
          toast(internal ? `Marked Internal: ${label}` : `Shown to Guests: ${label}`, {
            action: { label: "Undo", onClick: () => setInternal(!internal, false) },
          });
        },
        onError: (e) => toast.error(e.message),
      },
    );
  const items = (kit: MenuKit) => (
    <>
      <kit.Item onSelect={() => void navigate({ to: "/assets/$id", params: { id: asset.id }, search: { from: number } })}>
        <ExternalLinkIcon />
        Open Asset page
      </kit.Item>
      <kit.Item onSelect={() => void navigate({ to: "/search", search: { q: asset.value } })}>
        <SearchIcon />
        Search for this
      </kit.Item>
      <kit.Item onSelect={copy}>
        <CopyIcon />
        Copy value
      </kit.Item>
      {canMarkInternal && (
        <kit.Item disabled={mark.isPending} onSelect={() => setInternal(!asset.internal)}>
          {asset.internal ? <EyeIcon /> : <EyeOffIcon />}
          {asset.internal ? "Show to Guests" : "Mark Internal"}
        </kit.Item>
      )}
      {containment.length > 0 && (
        <>
          <kit.Separator />
          <kit.Label>Take action</kit.Label>
          <kit.Item onSelect={() => setContaining("contain")}>
            <WifiOffIcon />
            Contain host…
          </kit.Item>
          {canLiftContainment && (
            <kit.Item onSelect={() => setContaining("lift")}>
              <WifiIcon />
              Lift containment…
            </kit.Item>
          )}
        </>
      )}
      {onUnlink && (
        <>
          <kit.Separator />
          <kit.Item variant="destructive" onSelect={onUnlink}>
            <UnlinkIcon />
            Unlink from this Case
          </kit.Item>
        </>
      )}
    </>
  );
  const menuButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items(dropdownKit)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children(menuButton)}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">{items(contextKit)}</ContextMenuContent>
      </ContextMenu>
      {containing && (
        <ContainHostDialog number={number} asset={asset} integrations={containment} lift={containing === "lift"} onClose={() => setContaining(null)} />
      )}
    </>
  );
}

/**
 * "Take action on N": the ticked Observables, sent in one click to one Integration as IOC alerts or
 * blocks with its defaults, or, for Mimecast, their email addresses or domains blocked, or, for
 * Umbrella, their domains added to its destination list. Those this
 * Case already holds there are left out; "More options…" opens the full Falcon send dialog.
 */
export function BulkObservableActions({
  number,
  severity,
  observables,
  integrations,
  held,
  onSent,
}: {
  number: number;
  severity: Severity;
  observables: Sendable[];
  integrations: Destination[];
  held: readonly ResponseAction[];
  onSent: () => void;
}) {
  const quick = useQuickSend(number);
  const [more, setMore] = useState(false);
  const notHeldOn = (id: string) => observables.filter((o) => !holdingOn(held, o.id).some((r) => r.integration?.id === id));
  const hashes = observables.filter((o) => {
    const t = falconIocType(o.type, o.value);
    return t !== null && falconAllowsPrevent(t);
  });
  const emails = observables.filter((o) => o.type === "email");
  const domains = observables.filter((o) => o.type === "domain");
  const falconIntegrations = integrations.filter((i) => i.provider === "crowdstrike");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm">
            <ZapIcon />
            Take action on {observables.length}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {integrations.map((d, i) => {
            const left = notHeldOn(d.id);
            return (
              <div key={d.id} role="group" aria-label={d.name}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="grid">
                  <span>{d.name}</span>
                  {describeDefaults(d.defaults, severity, d.provider) && (
                    <span className="text-xs font-normal text-muted-foreground">{describeDefaults(d.defaults, severity, d.provider)}</span>
                  )}
                </DropdownMenuLabel>
                {(d.provider === "mimecast" ? MIMECAST_ACTIONS : d.provider === "umbrella" ? UMBRELLA_ACTIONS : FALCON_QUICK).map((action: ResponseActionAction) => {
                  const Icon = QuickIcon[action];
                  const going =
                    d.provider === "mimecast"
                      ? left.filter((o) => emails.includes(o))
                      : d.provider === "umbrella"
                        ? left.filter((o) => domains.includes(o))
                        : action === "prevent"
                          ? left.filter((o) => hashes.includes(o))
                          : left;
                  return (
                    <DropdownMenuItem
                      key={action}
                      disabled={going.length === 0 || quick.sending}
                      onSelect={() => quick.send({ observables: going, to: d, action, onSent })}
                    >
                      <Icon />
                      <Twoline
                        title={isFalcon(d) ? `${quickLabel[action]} (${falconIocActionLabel[action as FalconIocAction]})` : quickLabel[action]}
                        hint={
                          going.length === 0
                            ? d.provider === "mimecast" && left.length > 0
                              ? "Email addresses only, and none are ticked"
                              : d.provider === "umbrella" && left.length > 0
                                ? "Domains only, and none are ticked"
                              : action === "prevent" && left.length > 0
                                ? "Hashes only, and none are ticked"
                                : "Already sent from this Case"
                            : undefined
                        }
                      />
                    </DropdownMenuItem>
                  );
                })}
              </div>
            );
          })}
          {falconIntegrations.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setMore(true)}>
                <SlidersHorizontalIcon />
                More options…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {quick.confirm}
      {more && (
        <SendToFalconDialog
          defaultOpen
          onClose={() => setMore(false)}
          number={number}
          severity={severity}
          observables={observables}
          integrations={falconIntegrations}
          held={held}
          onSent={onSent}
        />
      )}
    </>
  );
}
