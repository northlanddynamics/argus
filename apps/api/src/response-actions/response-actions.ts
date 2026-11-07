import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { casePolicy, NotPermitted, visibleCases, visibleItems } from "../access/policy";
import { actorOf, CaseClosed, CaseNotFound, lockCase } from "../cases/cases";
import { type CaseActor, recordCaseAudit } from "../cases/case-audit-log";
import { type CaseAuditAction, caseRef, type Severity, severityLabel } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import {
  assetFalconDevices,
  assets,
  caseAssets,
  caseObservables,
  cases,
  ignoredObservables,
  integrations,
  observables,
  responseActionOutbox,
  responseActions,
  timelineEntries,
  user,
} from "../db/schema";
import type { FalconContainment } from "../crowdstrike/falcon";
import { requestHostEnrichment } from "../crowdstrike/host-enrichment";
import { secureId } from "../ids";
import { type Provider, providerCapabilities, providerLabel } from "../integrations/vocabulary";
import type { Membership, Participant } from "../members/membership";
import { falconDevicesOf, linkObservable, NotLinked } from "../observables/observables";
import { ASSET_TYPES, type AssetType, assetTypeLabel, defang, normaliseObservable, type ObservableType, observableTypeLabel } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import {
  CONTAINMENT_TARGET_TYPE,
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  type FalconIocDefaults,
  FALCON_IOC_PLATFORMS,
  type FalconIocPlatform,
  isHostKind,
  falconIocPlatformLabel,
  falconIocType,
  iocSeverity,
  LIVE_STATES,
  type MimecastAction,
  mimecastTarget,
  providerActions,
  providerKind,
  type ResponseActionAction,
  responseActionActionLabel,
  type ResponseActionKind,
  responseActionKindLabel,
  type ResponseActionOrigin,
  type ResponseActionState,
} from "./vocabulary";

/**
 * Response Actions (ADR 0007): a Member who can work a Case sends one of its Observables to an
 * Integration whose Response Actions setting is on: to CrowdStrike as a Falcon custom IOC, or to
 * Mimecast as an Organization-wide Blocked Senders entry for an email address or its domain (the
 * domain Observable is linked to the Case first if it isn't yet, and is what is blocked). The Response Action is
 * stored Pending with its outbox row in one transaction, and the worker carries it out
 * (`sender.ts`). Guests never take them, and nobody takes one on a Closed Case.
 *
 * Every state change is a Timeline Entry, recorded by the Member who took it, and a Case Audit Log
 * entry, and sends the Case's signal. Internal ones, and their Timeline Entries, are hidden from
 * Guests; Guests never see which Integration one went through, or why it failed.
 *
 * What Argus records is that it sent something, never that it is in force now: someone may have
 * changed it in the tool since.
 *
 * Argus never sends the same thing twice and never overwrites what is already in a tool. When the
 * Organization already has a Pending or Active Response Action that Argus created for the same
 * Integration, kind and target, from any Case, a new one is recorded Active and "already present",
 * pointing at it, and nothing is queued. The sender looks each one up in the tool before creating
 * it, and records it "already present in the tool" if it is there. Either kind of "already present"
 * record can be dismissed from its Case: it is Removed, and the tool is left alone. Restricted Cases
 * a viewer can't see are never named.
 *
 * Several can be taken at once: one per Observable per chosen Integration. An Observable a Provider
 * doesn't take is skipped, with the reason, and the rest go ahead. Sending an Ignored Observable
 * needs the request to confirm it.
 *
 * Only the Response Action that created something in a tool can remove it: it is Removing, with its
 * removal queued for the worker, and Removed once the tool has deleted it or says it is already
 * gone. Other Cases' "already present" records relying on it are then Removed too, and removing it
 * while they rely on it needs the request to confirm it. On a Closed Case only Admins remove.
 *
 * Containment (ADR 0009) is a Response Action against a host Asset linked to the Case: one Falcon
 * device (`aid`) recorded on it, through a CrowdStrike Integration whose Host containment setting is
 * on (independent of its Response Actions setting). It is never one click: `containmentCheck` asks
 * the worker to refetch the host from Falcon, and the confirmation shows what came back before the
 * Member picks the device and contains it. A host with no device recorded can't be contained. One
 * Falcon already reports contained is recorded "already present in the tool", and nothing is sent.
 * Lifting containment Argus imposed is its removal, as for an IOC: Removing, then Removed once Falcon
 * has lifted it or reports the host already released.
 * Unlike an IOC, containment's real state comes back in Enrichment: a fetch showing the host released
 * moves every Active containment record for that device to Removed, "lifted in Falcon", attributed
 * to CrowdStrike (`containmentLiftedInFalcon`). So for containment, Active means Falcon last
 * reported the host contained.
 *
 * An Admin may lift containment that Argus didn't impose (set outside Argus, or recorded only as
 * already in the tool) as its own "Lift containment" Response Action (`liftContainment`), after
 * confirming they know Argus didn't impose it. It is refused while Argus holds containment of the
 * device, which is lifted from the Case that imposed it. Once Falcon has lifted it, every Active
 * containment record for the device, on any Case, is Removed, noting the Lift containment
 * (`containmentLiftedBy`). A Lift containment is never removed or dismissed. The exception to ADR
 * 0007's rule is for containment only.
 */

/** The Observable isn't of a type the Integration's Provider takes. */
export class ObservableNotAccepted extends Error {}
/** The Integration can't take this Response Action: no such Integration, the wrong Provider, or its Response Actions setting is off. */
export class IntegrationNotEligible extends Error {
  constructor(message = "That Integration doesn't take Response Actions; an Admin can turn them on in its settings") {
    super(message);
  }
}
export class ResponseActionNotFound extends Error {
  constructor() {
    super("No such Response Action on this Case");
  }
}
/** Only a Failed Response Action can be retried. */
export class NotRetryable extends Error {
  constructor() {
    super("Only a Failed Response Action can be retried");
  }
}
/** Only an Active Response Action that Argus created can be removed: an "already present" one is dismissed instead. */
export class NotRemovable extends Error {}
/**
 * Other Cases have "already present" records relying on the Response Action to be removed, and the
 * request didn't confirm removing it anyway. Names the Cases the person can see and counts the rest.
 */
export class RelyingCasesNotConfirmed extends Error {
  readonly cases: { number: number; title: string }[];
  readonly otherCases: number;
  constructor(named: { number: number; title: string }[], otherCases: number, verb = "remove") {
    const total = named.length + otherCases;
    super(`${total === 1 ? "Another Case relies" : `${total} other Cases rely`} on this Response Action; confirm to ${verb} it anyway`);
    this.cases = named;
    this.otherCases = otherCases;
  }
}
/** Only an Active "already present" record can be dismissed: Argus removes what it created instead. */
export class NotDismissable extends Error {
  constructor() {
    super("Only an Active Response Action that was already present can be dismissed");
  }
}

/** The host can't be contained as asked: no device is recorded on it, or not the one asked for. */
export class HostNotContainable extends Error {}

/** Argus holds containment of the device, so it is lifted from the Case that imposed it, not by a Lift containment. */
export class ContainmentImposedByArgus extends Error {
  readonly case: { number: number; title: string } | null;
  constructor(c: { number: number; title: string } | null) {
    super(
      c
        ? `Argus contained this host from ${caseRef(c.number)}; lift the containment there`
        : "Argus contained this host from another Case; the containment is lifted from that Case",
    );
    this.case = c;
  }
}

/** Lifting containment Argus didn't impose needs the request to confirm the Admin knows that. */
export class NotImposedNotConfirmed extends Error {
  constructor() {
    super("Argus didn't contain this host; confirm to lift its containment anyway");
  }
}

/** Some of the Observables are on the Ignored list, and the request didn't confirm sending them. */
export class IgnoredNotConfirmed extends Error {
  readonly observables: { id: string; type: ObservableType; value: string }[];
  constructor(unconfirmed: { id: string; type: ObservableType; value: string }[]) {
    super(
      unconfirmed.length === 1
        ? `${described(unconfirmed[0]!)} is on the Ignored list; confirm to send it anyway`
        : `${unconfirmed.length} of these Observables are on the Ignored list; confirm to send them anyway`,
    );
    this.observables = unconfirmed;
  }
}

/**
 * A Response Action to take: for Falcon, `action` is Detect, or Prevent for hashes; for Mimecast,
 * Block sender or Block domain, for an email address.
 */
export type NewResponseAction = {
  observableId: string;
  integrationId: string;
  action: ResponseActionAction;
  /** Hidden from the Case's Guests; the Integration's default if left out. */
  internal?: boolean;
  /** Sends it even if it is on the Ignored list. */
  confirmIgnored?: boolean;
};

/**
 * Response Actions to take at once: one per Observable per Integration, every Integration of the
 * Provider whose action `action` is. For Falcon it is Detect, or Prevent, which only hashes take:
 * domains and IPs in a Prevent send are skipped. For Mimecast it is Block sender or Block domain, and
 * anything but an email address is skipped.
 */
export type NewResponseActions = {
  observableIds: readonly string[];
  integrationIds: readonly string[];
  action: ResponseActionAction;
  /** Hidden from the Case's Guests; each Integration's default if left out. */
  internal?: boolean;
  /** Sends those on the Ignored list too; without it, any among them refuses the whole request. */
  confirmIgnored?: boolean;
};

/**
 * A host to contain: one Falcon device `deviceId` recorded on host Asset `assetId` for CrowdStrike
 * Integration `integrationId`.
 */
export type NewContainment = {
  assetId: string;
  integrationId: string;
  deviceId: string;
  /** Hidden from the Case's Guests; the Integration's default if left out. */
  internal?: boolean;
};

/** Containment Argus didn't impose to lift: as `NewContainment`, confirmed by the Admin. */
export type NewContainmentLift = NewContainment & {
  /** The Admin was warned that Argus didn't contain the host. */
  confirmNotImposed?: boolean;
};

/** An Observable left out of a send because a Provider doesn't take it, and why. */
export type Skipped = {
  observable: { id: string; type: ObservableType; value: string };
  provider: Provider;
  reason: string;
};

type Person = { id: string; name: string };

export type ResponseActionView = {
  id: string;
  kind: ResponseActionKind;
  state: ResponseActionState;
  /** What it was taken against: an Observable, or for containment a host Asset. Exactly one is set. */
  observable: { id: string; type: ObservableType; value: string } | null;
  asset: { id: string; type: AssetType; value: string } | null;
  /** What the tool was sent: for containment, the device (`aid`). */
  target: { type: string; value: string };
  /** What the IOC was sent with; `platforms` null for one taken before they were configurable, meaning all. */
  falcon: { action: FalconIocAction; severity: Severity; platforms: FalconIocPlatform[] | null } | null;
  /** The Integration it went through. Never told to Guests. */
  integration: { id: string; name: string } | null;
  /** Hidden from Guests. */
  internal: boolean;
  requestedBy: Person;
  requestedAt: string;
  /** When it reached its state. */
  stateChangedAt: string;
  /** When the tool accepted it; never "in force now". */
  sentAt: string | null;
  /** Why the latest attempt failed, while it is being retried or has Failed. Never told to Guests. */
  lastError: string | null;
  /** Whether Argus created it, or found it already sent from a Case or already in the tool. */
  origin: ResponseActionOrigin;
  /**
   * For one already sent from a Case: that Case, unless the viewer can't see it, and when Argus sent
   * it (or was asked to, if it hasn't yet).
   */
  presentFrom: { case: { number: number; title: string } | null; at: string } | null;
  /** Who dismissed it from this Case, and when. */
  dismissedBy: Person | null;
  dismissedAt: string | null;
  /** Who last asked Argus to remove it from the tool, and when. A Failed one with these set failed to be removed. */
  removalRequestedBy: Person | null;
  removalRequestedAt: string | null;
  /** When it moved to Removed because the tool showed it undone outside Argus: for containment, "lifted in Falcon". */
  liftedInToolAt: string | null;
  /**
   * For containment ended by an Admin's Lift containment: the Case it was taken from, unless the
   * viewer can't see it, and when it ended this record.
   */
  liftedBy: { case: { number: number; title: string } | null; at: string } | null;
};

/** A Response Action taken on an Observable, as its page lists it. */
export type ObservableResponseActionView = {
  id: string;
  kind: ResponseActionKind;
  state: ResponseActionState;
  origin: ResponseActionOrigin;
  /** The Case it was taken from. */
  case: { number: number; title: string };
  /** The Integration it went through. Never told to Guests. */
  integration: { id: string; name: string } | null;
  /** What the IOC was sent with; `platforms` null for one taken before they were configurable, meaning all. */
  falcon: { action: FalconIocAction; severity: Severity; platforms: FalconIocPlatform[] | null } | null;
  /** Hidden from Guests. */
  internal: boolean;
  requestedAt: string;
  stateChangedAt: string;
  /** When the tool accepted it; never "in force now". */
  sentAt: string | null;
};

/** The Integrations a Response Action can be sent to, as the Case offers them, with what they send it with. */
export type EligibleIntegration = { id: string; name: string; provider: Provider; defaults: FalconIocDefaults };

/** A CrowdStrike Integration a Member can contain hosts through, as the Case offers it. */
export type ContainmentIntegration = { id: string; name: string; internal: boolean };

/**
 * One Falcon device of a host, as the containment confirmation shows it: as of when it was last
 * fetched, and whether a fetch asked for is still to come.
 */
export type ContainmentDevice = {
  deviceId: string;
  consoleUrl: string;
  refreshing: boolean;
  fetchedAt: string | null;
  notFound: boolean;
  error: string | null;
  hostname: string | null;
  platform: string | null;
  osVersion: string | null;
  hostGroups: string[];
  lastSeen: string | null;
  containment: FalconContainment | null;
};

/** What the containment confirmation shows of a host: its devices through each Integration that contains hosts. */
export type ContainmentCheck = {
  asset: { id: string; value: string };
  integrations: {
    integration: ContainmentIntegration;
    /** Several devices are recorded: the Member picks one. */
    ambiguous: boolean;
    devices: ContainmentDevice[];
    /** Looking the host up by hostname, while no device is recorded. */
    lookup: { refreshing: boolean; checkedAt: string | null; notFound: boolean; error: string | null } | null;
  }[];
};

type Row = typeof responseActions.$inferSelect;

/** What a Response Action was taken against, as its records name it: an Observable, or a host Asset. */
export type Subject = { type: ObservableType | AssetType; value: string };

const isAssetType = (type: string): type is AssetType => (ASSET_TYPES as readonly string[]).includes(type);

/** "SHA-256 e3b0…" in full, defanged where it could be clicked; "Host FIN-LT-0231". */
const described = (o: Subject) => (isAssetType(o.type) ? `${assetTypeLabel[o.type]} ${o.value}` : `${observableTypeLabel[o.type]} ${defang(o.type, o.value)}`);

/** How the Case Audit Log names a Response Action: "Falcon custom IOC: SHA-256 e3b0…". */
export const responseActionLabel = (o: Subject, kind: ResponseActionKind = "falcon_ioc") => `${responseActionKindLabel[kind]}: ${described(o)}`;

/** The Observable or Asset a Response Action row was selected with, whichever it has. */
const subjectOf = (o: { type: string; value: string } | null, a: { type: string; value: string } | null): Subject =>
  o ? { type: o.type as ObservableType, value: o.value } : { type: a!.type as AssetType, value: a!.value };

/** What it was sent with: "Detect, severity High", "Block domain, everyone", or "device 8f1c…". */
const paramsOf = (r: Pick<Row, "kind" | "targetType" | "targetValue" | "falconAction" | "severity" | "falconPlatforms">) =>
  isHostKind(r.kind) ? `device ${r.targetValue}` :
  r.kind === "mimecast_blocked_sender" ? `${r.targetType === "domain" ? "Block domain" : "Block sender"}, everyone` : [
    falconIocActionLabel[r.falconAction!],
    `severity ${severityLabel[r.severity!]}`,
    ...(r.falconPlatforms && r.falconPlatforms.length < FALCON_IOC_PLATFORMS.length ? [r.falconPlatforms.map((p) => falconIocPlatformLabel[p]).join(", ")] : []),
  ].join(", ");

/** What happened to a Response Action, as its Timeline Entry and Case Audit Log entry say it. */
export type StateChange =
  | "requested"
  | "sent"
  | "failed"
  | "retried"
  | "already_present"
  | "in_tool"
  | "dismissed"
  | "removal_requested"
  | "removal_retried"
  | "removal_failed"
  | "removed"
  | "already_gone"
  | "relied_on_removed"
  | "lifted_in_tool"
  | "lifted_by_lift";

/** The changes that follow a request to remove it: their Timeline Entries are recorded by whoever asked. */
const REMOVAL_CHANGES = new Set<StateChange>(["removal_requested", "removal_retried", "removal_failed", "removed", "already_gone"]);

const auditAction: Record<StateChange, CaseAuditAction> = {
  requested: "response_action.requested",
  sent: "response_action.sent",
  failed: "response_action.failed",
  retried: "response_action.retried",
  already_present: "response_action.already_present",
  in_tool: "response_action.already_in_tool",
  dismissed: "response_action.dismissed",
  removal_requested: "response_action.removal_requested",
  removal_retried: "response_action.removal_retried",
  removal_failed: "response_action.removal_failed",
  removed: "response_action.removed",
  already_gone: "response_action.removed",
  relied_on_removed: "response_action.removed",
  lifted_in_tool: "response_action.removed",
  lifted_by_lift: "response_action.removed",
};

/** How removing `entry` from `tool` is put. */
const removal = (entry: string, tool: string) => ({
  remove: `remove ${entry} from ${tool}`,
  notRemoved: `Argus could not remove ${entry} from ${tool}`,
  removed: `Argus removed ${entry} from ${tool}`,
  alreadyGone: `${entry} was already gone from ${tool}`,
  reliedOnRemoved: `Argus removed ${entry} from ${tool} at the request of the Case that sent it, so this Case no longer records it as present`,
  liftedInTool: `${entry} was removed from ${tool} outside Argus`,
  liftedByLift: `${entry} was removed from ${tool}`,
});

/** How a Response Action's Timeline Entries and Audit Log entries put it, by kind. */
function phrasing(r: Row, o: Subject) {
  const what = described(o);
  if (r.kind === "falcon_containment_lift") {
    const tool = `${providerLabel.crowdstrike} Falcon`;
    return {
      tool,
      send: `lift the containment of ${what} in ${tool}, which Argus didn't impose (${paramsOf(r)})`,
      sent: `Argus lifted the containment of ${what} in ${tool} (${paramsOf(r)})`,
      notSent: `Argus could not lift the containment of ${what} in ${tool}`,
      alreadySent: `the containment of ${what} in ${tool} was already being lifted, so nothing was sent again`,
      inTool: `${what} was already released in ${tool}, so Argus sent nothing`,
      dismissed: `this Case no longer records lifting the containment of ${what} in ${tool}`,
      ...removal(`the lift of ${what}'s containment`, tool),
    };
  }
  if (r.kind === "falcon_containment") {
    const tool = `${providerLabel.crowdstrike} Falcon`;
    return {
      tool,
      send: `contain ${what} in ${tool} (${paramsOf(r)})`,
      sent: `Argus contained ${what} in ${tool} (${paramsOf(r)})`,
      notSent: `Argus could not contain ${what} in ${tool}`,
      alreadySent: `${what} was already contained in ${tool} by Argus, so nothing was sent again`,
      inTool: `${what} was already contained in ${tool}, so Argus sent nothing`,
      dismissed: `this Case no longer records ${what} as already contained in ${tool}`,
      remove: `lift the containment of ${what} in ${tool}`,
      notRemoved: `Argus could not lift the containment of ${what} in ${tool}`,
      removed: `Argus lifted the containment of ${what} in ${tool}`,
      alreadyGone: `${what} was already released in ${tool}`,
      reliedOnRemoved: `Argus lifted the containment of ${what} in ${tool} at the request of the Case that contained it, so this Case no longer records it as contained`,
      liftedInTool: `the containment of ${what} was lifted in ${tool}, outside Argus`,
      liftedByLift: `Argus lifted the containment of ${what} in ${tool} at an Admin's request, so this Case no longer records it as contained`,
    };
  }
  if (r.kind === "mimecast_blocked_sender") {
    const tool = providerLabel.mimecast;
    return {
      tool,
      send: `block ${what} in ${tool} as a blocked sender (${paramsOf(r)})`,
      sent: `Argus blocked ${what} in ${tool} as a blocked sender (${paramsOf(r)})`,
      notSent: `Argus could not block ${what} in ${tool}`,
      alreadySent: `${what} was already blocked in ${tool} by Argus, so nothing was sent again`,
      inTool: `${what} was already a blocked sender in ${tool}, so Argus left it unchanged`,
      dismissed: `this Case no longer records ${what} as already blocked in ${tool}`,
      ...removal(`the blocked sender entry for ${what}`, tool),
    };
  }
  const tool = `${providerLabel.crowdstrike} Falcon`;
  return {
    tool,
    send: `send ${what} to ${tool} as a custom IOC (${paramsOf(r)})`,
    sent: `Argus sent ${what} to ${tool} as a custom IOC (${paramsOf(r)})`,
    notSent: `Argus could not send ${what} to ${tool} as a custom IOC`,
    alreadySent: `${what} was already sent to ${tool} as a custom IOC by Argus, so nothing was sent again`,
    inTool: `${what} was already in ${tool} as a custom IOC, so Argus left it unchanged`,
    dismissed: `this Case no longer records ${what} as already in ${tool}`,
    ...removal(`the custom IOC for ${what}`, tool),
  };
}

/** The Timeline Entry's text: the Provider, never the Integration's name, and never an error. */
function timelineBody(change: StateChange, r: Row, o: Subject, by: string) {
  const p = phrasing(r, o);
  switch (change) {
    case "requested":
      return `Response Action taken by ${by}: ${p.send}.`;
    case "sent":
      return `Response Action: ${p.sent}.`;
    case "failed":
      return `Response Action failed: ${p.notSent}.`;
    case "retried":
      return `Response Action retried by ${by}: ${p.send}.`;
    case "already_present":
      return `Response Action by ${by}: ${p.alreadySent}.`;
    case "in_tool":
      return `Response Action: ${p.inTool}.`;
    case "dismissed":
      return `Response Action dismissed by ${by}: ${p.dismissed}; ${p.tool} was left unchanged.`;
    case "removal_requested":
      return `Response Action removal asked for by ${by}: ${p.remove}.`;
    case "removal_retried":
      return `Response Action removal retried by ${by}: ${p.remove}.`;
    case "removal_failed":
      return `Response Action removal failed: ${p.notRemoved}.`;
    case "removed":
      return `Response Action removed: ${p.removed}.`;
    case "already_gone":
      return `Response Action removed: ${p.alreadyGone}.`;
    case "relied_on_removed":
      return `Response Action removed: ${p.reliedOnRemoved}.`;
    case "lifted_in_tool":
      return `Response Action removed: ${p.liftedInTool}.`;
    case "lifted_by_lift":
      return `Response Action removed: ${p.liftedByLift}.`;
  }
}

/** What the Case Audit Log says of a change, unless an error says it instead. */
function auditDetail(change: StateChange, r: Row) {
  const tool = r.kind === "mimecast_blocked_sender" ? providerLabel.mimecast : `${providerLabel.crowdstrike} Falcon`;
  if (r.kind === "falcon_containment_lift") {
    switch (change) {
      case "requested":
        return `${paramsOf(r)}; Argus didn't impose the containment`;
      case "in_tool":
        return `Already released in ${tool}; nothing was sent`;
    }
  }
  if (r.kind === "falcon_containment") {
    switch (change) {
      case "removed":
        return `Containment lifted in ${tool}`;
      case "already_gone":
        return `Already released in ${tool}; nothing to lift`;
      case "relied_on_removed":
        return `Containment lifted in ${tool} by the Case that contained it`;
      case "lifted_in_tool":
        return `Lifted in ${tool}, outside Argus`;
      case "lifted_by_lift":
        return `Containment lifted in ${tool} by an Admin's Lift containment`;
      case "removal_requested":
      case "removal_retried":
        return `Lift containment in ${tool}`;
    }
  }
  switch (change) {
    case "already_present":
      return "Already present: sent by Argus before; nothing was sent";
    case "in_tool":
      return r.kind === "falcon_containment" ? `Already contained in ${tool}; nothing was sent` : `Already present in ${tool}; nothing was written`;
    case "dismissed":
      return `Dismissed; ${tool} left unchanged`;
    case "removed":
      return `Removed from ${tool}`;
    case "already_gone":
      return `Already gone from ${tool}; nothing to remove`;
    case "relied_on_removed":
      return `Removed from ${tool} by the Case that sent it`;
    case "lifted_in_tool":
      return `Removed in ${tool}, outside Argus`;
    case "lifted_by_lift":
      return `Removed from ${tool}`;
    case "removal_requested":
    case "removal_retried":
      return `Remove from ${tool}`;
    default:
      return paramsOf(r);
  }
}

/**
 * Records a change to Response Action `r` on its Case, in the transaction that makes it: a Timeline
 * Entry recorded by the Member who took it, or by `by` (Internal when it is), a Case Audit Log entry
 * by `actor`, and the Case's signal. `detail` goes in the Audit Log only, such as an error.
 */
export async function recordStateChange(
  tx: Tx,
  { r, subject, change, actor, now, detail, by }: {
    r: Row;
    subject: Subject;
    change: StateChange;
    actor: CaseActor;
    now: Date;
    detail?: string | null;
    by?: { id: string; name: string };
  },
) {
  const recorderId = by?.id ?? (REMOVAL_CHANGES.has(change) && r.removalRequestedById ? r.removalRequestedById : r.createdById);
  const [taker] = by ? [by] : await tx.select({ name: user.name }).from(user).where(eq(user.id, recorderId));
  await tx.insert(timelineEntries).values({
    id: secureId(),
    organizationId: r.organizationId,
    caseId: r.caseId,
    occurredKind: "exact",
    occurredStart: now,
    occurredEnd: null,
    occurredPrecisionMinutes: null,
    body: timelineBody(change, r, subject, taker?.name ?? "unknown"),
    citations: [],
    internal: r.internal,
    responseActionId: r.id,
    version: 1,
    recordedById: recorderId,
    recordedAt: now,
  });
  await recordCaseAudit(tx, {
    organizationId: r.organizationId,
    caseId: r.caseId,
    occurredAt: now,
    actor,
    action: auditAction[change],
    target: responseActionLabel(subject, r.kind),
    after: detail ?? auditDetail(change, r),
  });
  await publish(tx, { kind: "case", organizationId: r.organizationId, caseId: r.caseId, membersOnly: r.internal });
}

/** Who the Case Audit Log says lifted containment in Falcon outside Argus. */
const CROWDSTRIKE: CaseActor = { type: "crowdstrike", name: providerLabel.crowdstrike };

/**
 * Falcon reported devices `deviceIds` of CrowdStrike Integration `integrationId` released, in a fetch
 * asked for at `askedAt` (ADR 0009). Every containment Response Action for them that was Active by
 * then, on any Case and whatever its origin, moves to Removed, marked lifted in Falcon, and the Case
 * Audit Log attributes that to CrowdStrike. One that became Active after the fetch was asked for is
 * left alone, since what Falcon said may predate it. Call in the transaction storing the fetch.
 */
export async function containmentLiftedInFalcon(tx: Tx, { integrationId, deviceIds, askedAt, now }: { integrationId: string; deviceIds: readonly string[]; askedAt: Date; now: Date }) {
  if (!deviceIds.length) return;
  const r = responseActions;
  const ended = await tx
    .select({ id: r.id, asset: { type: assets.type, value: assets.value } })
    .from(r)
    .innerJoin(assets, eq(r.assetId, assets.id))
    .where(
      and(
        eq(r.integrationId, integrationId),
        eq(r.kind, "falcon_containment"),
        eq(r.targetType, CONTAINMENT_TARGET_TYPE),
        inArray(r.targetValue, [...deviceIds]),
        eq(r.state, "active"),
        lte(r.stateChangedAt, askedAt),
      ),
    )
    .orderBy(asc(r.seq))
    .for("update", { of: r });
  for (const e of ended) {
    const [lifted] = await tx
      .update(r)
      .set({ state: "removed", stateChangedAt: now, liftedInToolAt: now, lastError: null })
      .where(and(eq(r.id, e.id), eq(r.state, "active")))
      .returning();
    if (!lifted) continue;
    await recordStateChange(tx, { r: lifted, subject: { type: e.asset.type as AssetType, value: e.asset.value }, change: "lifted_in_tool", actor: CROWDSTRIKE, now });
  }
}

/**
 * Falcon lifted containment of the device that Lift containment `lift` (ADR 0009) is against. Every
 * containment Response Action for that device through its Integration that is Active, on any Case and
 * whatever its origin, moves to Removed, noting `lift`. Call in the transaction recording the lift.
 */
export async function containmentLiftedBy(tx: Tx, lift: Row, now: Date) {
  const r = responseActions;
  const ended = await tx
    .select({ id: r.id, asset: { type: assets.type, value: assets.value } })
    .from(r)
    .innerJoin(assets, eq(r.assetId, assets.id))
    .where(
      and(
        eq(r.integrationId, lift.integrationId),
        eq(r.kind, "falcon_containment"),
        eq(r.targetType, CONTAINMENT_TARGET_TYPE),
        eq(r.targetValue, lift.targetValue),
        eq(r.state, "active"),
      ),
    )
    .orderBy(asc(r.seq))
    .for("update", { of: r });
  for (const e of ended) {
    const [lifted] = await tx
      .update(r)
      .set({ state: "removed", stateChangedAt: now, liftedById: lift.id, lastError: null })
      .where(and(eq(r.id, e.id), eq(r.state, "active")))
      .returning();
    if (!lifted) continue;
    await recordStateChange(tx, { r: lifted, subject: { type: e.asset.type as AssetType, value: e.asset.value }, change: "lifted_by_lift", actor: ARGUS, now });
  }
}

/** Who the Case Audit Log says made a change the worker made. */
const ARGUS: CaseActor = { type: "system", name: "Argus" };

/** Queues an attempt to send Response Action `id`, or to remove it, due now. */
const queue = (tx: Tx, organizationId: string, id: string, now: Date, operation: "send" | "remove" = "send") =>
  tx.insert(responseActionOutbox).values({
    id: secureId(),
    organizationId,
    responseActionId: id,
    operation,
    state: "pending",
    nextAttemptAt: now,
    createdAt: now,
  });

/**
 * Holds, until the transaction ends, the right to create a Response Action for this Integration, kind
 * and target, so two Cases sending the same thing at once can't both create it.
 */
const lockTarget = (tx: Tx, r: { integrationId: string; kind: ResponseActionKind; targetType: string; targetValue: string }) =>
  tx.execute(sql`select pg_advisory_xact_lock(${TARGET_LOCK_NAMESPACE}, hashtext(${[r.integrationId, r.kind, r.targetType, r.targetValue].join("\n")}))`);
/** The first half of the advisory lock key, naming Response Action target locks. */
const TARGET_LOCK_NAMESPACE = 0x41524741;

/**
 * The Response Action that Argus created for this Integration, kind and target and that still holds
 * it (Pending, Active, Removing, or Failed to be removed), if any (other than `except`). Call with the
 * target locked. Locks it against changes, so that once a removal is done it isn't relied on.
 */
async function liveCreated(
  tx: Tx,
  r: { integrationId: string; kind: ResponseActionKind; targetType: string; targetValue: string },
  except?: string,
) {
  const t = responseActions;
  const [found] = await tx
    .select({ id: t.id, falconAction: t.falconAction, severity: t.severity, falconPlatforms: t.falconPlatforms })
    .from(t)
    .where(
      and(
        eq(t.integrationId, r.integrationId),
        eq(t.kind, r.kind),
        eq(t.targetType, r.targetType),
        eq(t.targetValue, r.targetValue),
        eq(t.origin, "created"),
        or(inArray(t.state, [...LIVE_STATES]), and(eq(t.state, "failed"), isNotNull(t.removalRequestedAt))),
        except ? ne(t.id, except) : undefined,
      ),
    )
    .limit(1)
    .for("key share");
  return found ?? null;
}

/** The Integrations in `me`'s Organization that take Response Actions now, of any Provider. */
async function eligible(db: Db | Tx, organizationId: string): Promise<EligibleIntegration[]> {
  const rows = await db
    .select({ id: integrations.id, name: integrations.name, provider: integrations.provider, defaults: integrations.responseActionDefaults })
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.responseActions, true)))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));
  return rows.filter((r) => providerCapabilities[r.provider].responseActions);
}

/** The other Cases (than `caseId`) whose Active "already present" records rely on Response Action `id`. */
async function relyingCaseIds(tx: Tx, id: string, caseId: string) {
  const t = responseActions;
  const rows = await tx
    .selectDistinct({ caseId: t.caseId })
    .from(t)
    .where(and(eq(t.presentFromId, id), eq(t.state, "active"), eq(t.origin, "already_present"), ne(t.caseId, caseId)));
  return rows.map((x) => x.caseId);
}

/** Response Action `id` on the locked Case `caseId`, locked, with its Observable or Asset; else `ResponseActionNotFound`. */
async function lock(tx: Tx, caseId: string, id: string) {
  const [found] = await tx
    .select({ row: responseActions, observable: { type: observables.type, value: observables.value }, asset: { type: assets.type, value: assets.value } })
    .from(responseActions)
    .leftJoin(observables, eq(responseActions.observableId, observables.id))
    .leftJoin(assets, eq(responseActions.assetId, assets.id))
    .where(and(eq(responseActions.id, id), eq(responseActions.caseId, caseId)))
    .for("update", { of: responseActions });
  if (!found) throw new ResponseActionNotFound();
  return { r: found.row, subject: subjectOf(found.observable, found.asset) };
}

/**
 * Host `input.assetId`, linked to Case `caseId`, and CrowdStrike Integration `input.integrationId`,
 * which contains hosts, with device `input.deviceId` recorded on the host for it. Throws `NotLinked`,
 * `IntegrationNotEligible` and `HostNotContainable`. Shares the Integration's row until the
 * transaction ends.
 */
async function hostDevice(tx: Tx, me: Membership, caseId: string, input: { assetId: string; integrationId: string; deviceId: string }) {
  const [host] = await tx
    .select({ id: assets.id, type: assets.type, value: assets.value })
    .from(caseAssets)
    .innerJoin(assets, eq(caseAssets.itemId, assets.id))
    .where(and(eq(caseAssets.caseId, caseId), eq(caseAssets.itemId, input.assetId), isNull(caseAssets.unlinkedAt)))
    .limit(1);
  if (!host || host.type !== "host") throw new NotLinked("That host isn't linked to this Case");
  const [integration] = await tx
    .select({ id: integrations.id, provider: integrations.provider, hostContainment: integrations.hostContainment, defaults: integrations.responseActionDefaults })
    .from(integrations)
    .where(and(eq(integrations.id, input.integrationId), eq(integrations.organizationId, me.organizationId)))
    .for("share");
  if (!integration || integration.provider !== "crowdstrike" || !integration.hostContainment) {
    throw new IntegrationNotEligible("That Integration doesn't contain hosts; an Admin can turn Host containment on in its settings");
  }
  const recorded = await tx
    .select({ deviceId: assetFalconDevices.deviceId })
    .from(assetFalconDevices)
    .where(and(eq(assetFalconDevices.assetId, host.id), eq(assetFalconDevices.integrationId, integration.id)));
  if (!recorded.length) throw new HostNotContainable("Falcon has no device recorded for this host, so it can't be contained");
  if (!recorded.some((d) => d.deviceId === input.deviceId)) throw new HostNotContainable("That device isn't recorded on this host");
  return { host, integration };
}

/**
 * Throws `ContainmentImposedByArgus`, naming the Case if `me` can see it, when Argus holds
 * containment of device `deviceId` through Integration `integrationId`. Call with the target locked.
 */
async function refuseImposed(tx: Tx, me: Membership, integrationId: string, deviceId: string) {
  const held = await liveCreated(tx, { integrationId, kind: "falcon_containment", targetType: CONTAINMENT_TARGET_TYPE, targetValue: deviceId });
  if (!held) return;
  const [c] = await tx
    .select({ number: cases.number, title: cases.title })
    .from(responseActions)
    .innerJoin(cases, eq(responseActions.caseId, cases.id))
    .where(and(eq(responseActions.id, held.id), visibleCases(me)));
  throw new ContainmentImposedByArgus(c ?? null);
}

/** The CrowdStrike Integrations in the Organization that contain hosts now, oldest first. */
async function containing(db: Db | Tx, organizationId: string): Promise<ContainmentIntegration[]> {
  const rows = await db
    .select({ id: integrations.id, name: integrations.name, defaults: integrations.responseActionDefaults })
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, "crowdstrike"), eq(integrations.hostContainment, true)))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));
  return rows.map((r) => ({ id: r.id, name: r.name, internal: r.defaults.internal }));
}

export function responseActionStore({ db, clock }: { db: Db; clock: Clock }) {
  async function visibleCaseId(me: Participant, number: number) {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    return found.id;
  }

  /** The Response Actions on Case `caseId` that `me` may see, oldest first; `ids` narrows them. */
  async function select(me: Participant, caseId: string, ids?: readonly string[]): Promise<ResponseActionView[]> {
    const r = responseActions;
    const originalAction = alias(responseActions, "original");
    const originalCaseRow = alias(cases, "original_case");
    const dismisser = alias(user, "dismisser");
    const remover = alias(user, "remover");
    const lift = alias(responseActions, "lift");
    const rows = await db
      .select({
        row: r,
        observable: { id: observables.id, type: observables.type, value: observables.value },
        asset: { id: assets.id, type: assets.type, value: assets.value },
        integrationName: integrations.name,
        requestedByName: user.name,
        dismissedByName: dismisser.name,
        removerName: remover.name,
        original: { at: sql<Date>`coalesce(${originalAction.sentAt}, ${originalAction.createdAt})`.mapWith(originalAction.createdAt), caseId: originalAction.caseId },
        originalCase: { number: originalCaseRow.number, title: originalCaseRow.title },
        liftCaseId: lift.caseId,
      })
      .from(r)
      .leftJoin(observables, eq(r.observableId, observables.id))
      .leftJoin(assets, eq(r.assetId, assets.id))
      .innerJoin(integrations, eq(r.integrationId, integrations.id))
      .innerJoin(user, eq(r.createdById, user.id))
      .leftJoin(dismisser, eq(r.dismissedById, dismisser.id))
      .leftJoin(remover, eq(r.removalRequestedById, remover.id))
      .leftJoin(originalAction, eq(r.presentFromId, originalAction.id))
      .leftJoin(originalCaseRow, eq(originalAction.caseId, originalCaseRow.id))
      .leftJoin(lift, eq(r.liftedById, lift.id))
      .where(and(eq(r.caseId, caseId), visibleItems(me, r.internal), ids ? inArray(r.id, [...ids]) : undefined))
      .orderBy(asc(r.seq));
    const insider = casePolicy.canSeeInternal(me);
    // The Cases the originals were sent from, and Lift containments taken from, that `me` may see; the rest go unnamed.
    const otherCaseIds = [...new Set(rows.flatMap((x) => [x.original?.caseId, x.liftCaseId].filter((id): id is string => !!id)))];
    const seenCases = new Map(
      otherCaseIds.length
        ? (
            await db
              .select({ id: cases.id, number: cases.number, title: cases.title })
              .from(cases)
              .where(and(visibleCases(me), inArray(cases.id, otherCaseIds)))
          ).map((c) => [c.id, { number: c.number, title: c.title }])
        : [],
    );
    return rows.map(({ row, observable, asset, integrationName, requestedByName, dismissedByName, removerName, original, originalCase, liftCaseId }) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      observable: observable ? { id: observable.id, type: observable.type as ObservableType, value: observable.value } : null,
      asset: asset ? { id: asset.id, type: asset.type as AssetType, value: asset.value } : null,
      target: { type: row.targetType, value: row.targetValue },
      falcon: row.falconAction && row.severity ? { action: row.falconAction, severity: row.severity, platforms: row.falconPlatforms } : null,
      integration: insider ? { id: row.integrationId, name: integrationName } : null,
      internal: row.internal,
      requestedBy: { id: row.createdById, name: requestedByName },
      requestedAt: row.createdAt.toISOString(),
      stateChangedAt: row.stateChangedAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
      lastError: insider ? row.lastError : null,
      origin: row.origin,
      presentFrom:
        original?.caseId && originalCase
          ? { case: seenCases.has(original.caseId) ? originalCase : null, at: original.at.toISOString() }
          : null,
      dismissedBy: row.dismissedById && dismissedByName ? { id: row.dismissedById, name: dismissedByName } : null,
      dismissedAt: row.dismissedAt?.toISOString() ?? null,
      removalRequestedBy: row.removalRequestedById && removerName ? { id: row.removalRequestedById, name: removerName } : null,
      removalRequestedAt: row.removalRequestedAt?.toISOString() ?? null,
      liftedInToolAt: row.liftedInToolAt?.toISOString() ?? null,
      liftedBy: liftCaseId ? { case: seenCases.get(liftCaseId) ?? null, at: row.stateChangedAt.toISOString() } : null,
    }));
  }

  const store = {
    /**
     * The Response Actions on Case `number` that `me` may see, and, for Members, the Integrations they
     * can send to and those they can contain hosts through. Throws `CaseNotFound` when `me` can't see the Case.
     */
    async list(me: Participant, number: number) {
      const caseId = await visibleCaseId(me, number);
      const member = casePolicy.canWork(me);
      return {
        responseActions: await select(me, caseId),
        integrations: member ? await eligible(db, me.organizationId) : [],
        containment: member ? await containing(db, me.organizationId) : [],
      };
    },

    /**
     * What the containment confirmation shows of host `assetId`, linked to Case `number`: its Falcon
     * devices through each Integration that contains hosts, as last fetched. With `refresh`, as when
     * the confirmation opens, every device of the host is first asked for afresh (and the host looked
     * up by hostname where no device is recorded); the worker fetches them and `refreshing` clears.
     * Members only. Throws `CaseNotFound` and `NotLinked`.
     */
    async containmentCheck(me: Membership, number: number, assetId: string, { refresh = false } = {}): Promise<ContainmentCheck> {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const caseId = await visibleCaseId(me, number);
      const [host] = await db
        .select({ id: assets.id, value: assets.value })
        .from(caseAssets)
        .innerJoin(assets, eq(caseAssets.itemId, assets.id))
        .where(and(eq(caseAssets.caseId, caseId), eq(caseAssets.itemId, assetId), isNull(caseAssets.unlinkedAt), eq(assets.type, "host")))
        .limit(1);
      if (!host) throw new NotLinked("That host isn't linked to this Case");
      if (refresh) await requestHostEnrichment(db, host.id, clock.now());
      const offered = await containing(db, me.organizationId);
      const groups = new Map((await falconDevicesOf(db, host.id)).map((g) => [g.integration.id, g]));
      return {
        asset: host,
        integrations: offered.map((integration) => {
          const g = groups.get(integration.id);
          return {
            integration,
            ambiguous: g?.ambiguous ?? false,
            devices: (g?.devices ?? []).map(({ deviceId, consoleUrl, enrichment: e }) => ({
              deviceId,
              consoleUrl,
              refreshing: e.refreshing,
              fetchedAt: e.fetchedAt,
              notFound: e.notFound,
              error: e.error,
              hostname: e.host?.hostname ?? null,
              platform: e.host?.platform ?? null,
              osVersion: e.host?.osVersion ?? null,
              hostGroups: e.host?.hostGroups ?? [],
              lastSeen: e.host?.lastSeen ?? null,
              containment: e.host?.containment ?? null,
            })),
            lookup: g?.lookup ?? (g ? null : { refreshing: refresh, checkedAt: null, notFound: false, error: null }),
          };
        }),
      };
    },

    /**
     * Contains a host: device `deviceId` of host `assetId`, linked to Case `number`, through
     * CrowdStrike Integration `integrationId`. Stored Pending and queued for the worker, or recorded
     * already present when Argus has already contained that device. Throws `NotLinked` when the host
     * isn't linked to the Case, `IntegrationNotEligible` when the Integration doesn't contain hosts,
     * and `HostNotContainable` when the device isn't recorded on the host. Not on a Closed Case.
     */
    async contain(me: Membership, number: number, input: NewContainment): Promise<ResponseActionView> {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const outcome = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const { host, integration } = await hostDevice(tx, me, current.id, input);
        const target = { integrationId: integration.id, kind: "falcon_containment" as const, targetType: CONTAINMENT_TARGET_TYPE, targetValue: input.deviceId };
        await lockTarget(tx, target);
        // Already contained by Argus, from this Case or another: recorded, and nothing is sent again.
        const presentFromId = (await liveCreated(tx, target))?.id ?? null;
        const id = secureId();
        const [r] = await tx
          .insert(responseActions)
          .values({
            id,
            organizationId: me.organizationId,
            caseId: current.id,
            assetId: host.id,
            ...target,
            state: presentFromId ? "active" : "pending",
            origin: presentFromId ? "already_present" : "created",
            presentFromId,
            internal: input.internal ?? integration.defaults.internal,
            createdById: me.userId,
            createdAt: now,
            stateChangedAt: now,
          })
          .returning();
        const subject = { type: "host" as const, value: host.value };
        if (presentFromId) {
          await recordStateChange(tx, { r: r!, subject, change: "already_present", actor: actorOf(me), now });
        } else {
          await queue(tx, me.organizationId, id, now);
          await recordStateChange(tx, { r: r!, subject, change: "requested", actor: actorOf(me), now });
        }
        return { caseId: current.id, id };
      });
      return (await select(me, outcome.caseId, [outcome.id]))[0]!;
    },

    /**
     * Lifts containment that Argus didn't impose (ADR 0009): device `deviceId` of host `assetId`,
     * linked to Case `number`, through CrowdStrike Integration `integrationId`, as its own Lift
     * containment Response Action, stored Pending and queued for the worker. Admins only
     * (`NotPermitted`), and only with `confirmNotImposed` (`NotImposedNotConfirmed`). Throws
     * `ContainmentImposedByArgus` while Argus holds containment of the device, and as `contain` does
     * otherwise. Not on a Closed Case.
     */
    async liftContainment(me: Membership, number: number, input: NewContainmentLift): Promise<ResponseActionView> {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      if (!casePolicy.canLiftForeignContainment(me)) throw new NotPermitted("Only Admins can lift containment that Argus didn't impose");
      const now = clock.now();
      const outcome = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const { host, integration } = await hostDevice(tx, me, current.id, input);
        // Held against a containment being sent from another Case meanwhile.
        await lockTarget(tx, { integrationId: integration.id, kind: "falcon_containment", targetType: CONTAINMENT_TARGET_TYPE, targetValue: input.deviceId });
        await refuseImposed(tx, me, integration.id, input.deviceId);
        if (!input.confirmNotImposed) throw new NotImposedNotConfirmed();
        const id = secureId();
        const [r] = await tx
          .insert(responseActions)
          .values({
            id,
            organizationId: me.organizationId,
            caseId: current.id,
            assetId: host.id,
            integrationId: integration.id,
            kind: "falcon_containment_lift",
            targetType: CONTAINMENT_TARGET_TYPE,
            targetValue: input.deviceId,
            state: "pending",
            origin: "created",
            internal: input.internal ?? integration.defaults.internal,
            createdById: me.userId,
            createdAt: now,
            stateChangedAt: now,
          })
          .returning();
        await queue(tx, me.organizationId, id, now);
        await recordStateChange(tx, { r: r!, subject: { type: "host", value: host.value }, change: "requested", actor: actorOf(me), now });
        return { caseId: current.id, id };
      });
      return (await select(me, outcome.caseId, [outcome.id]))[0]!;
    },

    /**
     * Takes Response Actions: sends each of Observables `observableIds`, linked to Case `number`, to
     * each of Integrations `integrationIds` as a Falcon custom IOC. Each is stored Pending and queued
     * for the worker, or recorded already present. Observables Falcon doesn't take as asked are
     * skipped, with the reason. Throws `NotLinked` if one isn't linked to the Case,
     * `IntegrationNotEligible` if an Integration can't take them, and `IgnoredNotConfirmed` if one to
     * be sent is on the Ignored list and the request didn't confirm it; then nothing is taken.
     */
    async takeMany(me: Membership, number: number, input: NewResponseActions): Promise<{ responseActions: ResponseActionView[]; skipped: Skipped[] }> {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const observableIds = [...new Set(input.observableIds)];
      const integrationIds = [...new Set(input.integrationIds)];
      const outcome = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const linked = await tx
          .select({ id: observables.id, type: observables.type, value: observables.value, key: observables.matchKey })
          .from(caseObservables)
          .innerJoin(observables, eq(caseObservables.itemId, observables.id))
          .where(and(eq(caseObservables.caseId, current.id), inArray(caseObservables.itemId, observableIds), isNull(caseObservables.unlinkedAt)));
        if (linked.length !== observableIds.length) {
          throw new NotLinked(observableIds.length === 1 ? "That Observable isn't linked to this Case" : "Some of those Observables aren't linked to this Case");
        }
        const byId = new Map(linked.map((o) => [o.id, { ...o, type: o.type as ObservableType }]));
        const chosen = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(inArray(integrations.id, integrationIds), eq(integrations.organizationId, me.organizationId)))
          .for("share");
        const eligibleNow = await eligible(tx, me.organizationId);
        const offered = new Map(eligibleNow.map((i) => [i.id, i.defaults]));
        if (chosen.length !== integrationIds.length || !chosen.every((i) => offered.has(i.id))) throw new IntegrationNotEligible();
        // Each action is one Provider's: every Integration chosen must be of it.
        for (const id of integrationIds) {
          const { provider } = eligibleNow.find((i) => i.id === id)!;
          if (!providerActions[provider].includes(input.action)) {
            throw new IntegrationNotEligible(`${providerLabel[provider]} Integrations don't take "${responseActionActionLabel[input.action]}"`);
          }
        }
        const provider = eligibleNow.find((i) => i.id === integrationIds[0])!.provider;
        const kind = providerKind[provider];

        // In the order asked: what the Provider takes goes ahead, the rest are skipped with the reason.
        const skipped: Skipped[] = [];
        const accepted: { id: string; type: ObservableType; value: string; key: string; targetType: string; targetValue: string }[] = [];
        for (const id of observableIds) {
          const o = byId.get(id)!;
          const observable = { id, type: o.type, value: o.value };
          if (provider === "mimecast") {
            const target = mimecastTarget(o.type, o.key, input.action as MimecastAction);
            if (!target) skipped.push({ observable, provider, reason: `Mimecast blocks email senders; it takes no ${observableTypeLabel[o.type]}` });
            else accepted.push({ ...o, targetType: target.type, targetValue: target.value });
            continue;
          }
          const iocType = falconIocType(o.type, o.key);
          if (!iocType) skipped.push({ observable, provider, reason: `Falcon takes no custom IOC for an ${observableTypeLabel[o.type]}` });
          else if (input.action === "prevent" && !falconAllowsPrevent(iocType)) {
            skipped.push({ observable, provider, reason: "Falcon can only Detect a domain or IP; Prevent is for hashes" });
          } else accepted.push({ ...o, targetType: iocType, targetValue: o.key });
        }

        if (!input.confirmIgnored && accepted.length) {
          const ignored = new Set(
            (
              await tx
                .select({ id: ignoredObservables.observableId })
                .from(ignoredObservables)
                .where(and(inArray(ignoredObservables.observableId, accepted.map((o) => o.id)), isNull(ignoredObservables.endedAt)))
            ).map((r) => r.id),
          );
          const unconfirmed = accepted.filter((o) => ignored.has(o.id));
          if (unconfirmed.length) throw new IgnoredNotConfirmed(unconfirmed.map(({ id, type, value }) => ({ id, type, value })));
        }

        // Blocking a domain blocks the domain Observable: linked to the Case by hand first, unless it already is.
        const subjects: (typeof accepted)[number][] = [];
        for (const o of accepted) {
          if (o.targetType !== "domain" || provider !== "mimecast") {
            subjects.push(o);
            continue;
          }
          const domain = normaliseObservable("domain", o.targetValue);
          if (!domain) throw new Error(`${o.targetValue} is not a domain`);
          const [linkedAlready] = await tx
            .select({ id: observables.id, value: observables.value })
            .from(caseObservables)
            .innerJoin(observables, eq(caseObservables.itemId, observables.id))
            .where(and(eq(caseObservables.caseId, current.id), isNull(caseObservables.unlinkedAt), eq(observables.type, "domain"), eq(observables.matchKey, domain.key)))
            .limit(1);
          const itemId = linkedAlready?.id ?? (await linkObservable(tx, me, current, "domain", domain, now)).itemId;
          subjects.push({ ...o, id: itemId, type: "domain" as const, value: linkedAlready?.value ?? domain.value });
        }
        const pairs = subjects
          .filter((o, i) => subjects.findIndex((x) => x.id === o.id) === i)
          .flatMap((o) =>
            integrationIds.map((integrationId) => ({
              o,
              target: { integrationId, kind, targetType: o.targetType, targetValue: o.targetValue },
            })),
          );
        // Every target locked first, in one order, so two sends sharing targets can't deadlock.
        const lockKey = ({ target: t }: (typeof pairs)[number]) => [t.integrationId, t.targetType, t.targetValue].join("\n");
        for (const pair of pairs.toSorted((a, b) => (lockKey(a) < lockKey(b) ? -1 : lockKey(a) > lockKey(b) ? 1 : 0))) await lockTarget(tx, pair.target);

        const ids: string[] = [];
        for (const { o, target } of pairs) {
          const id = secureId();
          const observable = { type: o.type, value: o.value };
          // Already sent by Argus, from this Case or another: recorded, and nothing is sent again.
          const present = await liveCreated(tx, target);
          const presentFromId = present?.id ?? null;
          const [r] = await tx
            .insert(responseActions)
            .values({
              id,
              organizationId: me.organizationId,
              caseId: current.id,
              observableId: o.id,
              ...target,
              // An already present record says what the tool holds: what it was sent with.
              ...(kind === "falcon_ioc"
                ? {
                    falconAction: present?.falconAction ?? (input.action as FalconIocAction),
                    severity: present?.severity ?? iocSeverity(offered.get(target.integrationId)!, current.severity),
                    falconPlatforms: present ? present.falconPlatforms : offered.get(target.integrationId)!.platforms,
                  }
                : {}),
              state: presentFromId ? "active" : "pending",
              origin: presentFromId ? "already_present" : "created",
              presentFromId,
              internal: input.internal ?? offered.get(target.integrationId)!.internal,
              createdById: me.userId,
              createdAt: now,
              stateChangedAt: now,
            })
            .returning();
          if (presentFromId) {
            await recordStateChange(tx, { r: r!, subject: observable, change: "already_present", actor: actorOf(me), now });
          } else {
            await queue(tx, me.organizationId, id, now);
            await recordStateChange(tx, { r: r!, subject: observable, change: "requested", actor: actorOf(me), now });
          }
          ids.push(id);
        }
        return { caseId: current.id, ids, skipped };
      });
      return { responseActions: outcome.ids.length ? await select(me, outcome.caseId, outcome.ids) : [], skipped: outcome.skipped };
    },

    /**
     * Takes one Response Action: sends Observable `observableId`, linked to Case `number`, to
     * Integration `integrationId` as a Falcon custom IOC. Stored Pending and queued for the worker;
     * returns it. Throws `ObservableNotAccepted` when Falcon doesn't take it as asked.
     */
    async take(me: Membership, number: number, input: NewResponseAction) {
      const { responseActions: taken, skipped } = await store.takeMany(me, number, {
        observableIds: [input.observableId],
        integrationIds: [input.integrationId],
        action: input.action,
        internal: input.internal,
        confirmIgnored: input.confirmIgnored,
      });
      if (skipped[0]) throw new ObservableNotAccepted(skipped[0].reason);
      return taken[0]!;
    },

    /**
     * The Response Actions taken on Observable `observableId` that `me` may see: those on Cases they
     * can see, without Internal ones or Integration details for Guests. Newest first.
     */
    async onObservable(me: Participant, observableId: string): Promise<ObservableResponseActionView[]> {
      const r = responseActions;
      const rows = await db
        .select({ row: r, caseNumber: cases.number, caseTitle: cases.title, integrationName: integrations.name })
        .from(r)
        .innerJoin(cases, eq(r.caseId, cases.id))
        .innerJoin(integrations, eq(r.integrationId, integrations.id))
        .where(and(eq(r.observableId, observableId), eq(r.organizationId, me.organizationId), visibleCases(me), visibleItems(me, r.internal)))
        .orderBy(desc(r.createdAt), desc(r.seq));
      const insider = casePolicy.canSeeInternal(me);
      return rows.map(({ row, caseNumber, caseTitle, integrationName }) => ({
        id: row.id,
        kind: row.kind,
        state: row.state,
        origin: row.origin,
        case: { number: caseNumber, title: caseTitle },
        integration: insider ? { id: row.integrationId, name: integrationName } : null,
        falcon: row.falconAction && row.severity ? { action: row.falconAction, severity: row.severity, platforms: row.falconPlatforms } : null,
        internal: row.internal,
        requestedAt: row.createdAt.toISOString(),
        stateChangedAt: row.stateChangedAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      }));
    },

    /**
     * Tries a Failed Response Action again. If sending it failed, it is Pending and queued for the
     * worker; if Argus has sent the same thing from another Case since, it is recorded as already
     * present instead. Not on a Closed Case. If removing it failed, it is Removing and its removal is
     * queued again, by whoever retried; on a Closed Case only an Admin may.
     */
    async retry(me: Membership, number: number, id: string) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        const { r, subject } = await lock(tx, current.id, id);
        if (r.state !== "failed") throw new NotRetryable();
        if (r.removalRequestedAt) {
          if (current.status === "closed" && !casePolicy.canReopen(me)) throw new CaseClosed();
          const [removing] = await tx
            .update(responseActions)
            .set({ state: "removing", stateChangedAt: now, lastError: null, removalRequestedById: me.userId, removalRequestedAt: now })
            .where(eq(responseActions.id, id))
            .returning();
          await queue(tx, r.organizationId, id, now, "remove");
          await recordStateChange(tx, { r: removing!, subject, change: "removal_retried", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
          return current.id;
        }
        if (current.status === "closed") throw new CaseClosed();
        if (r.kind === "falcon_containment_lift") {
          if (!casePolicy.canLiftForeignContainment(me)) throw new NotPermitted("Only Admins can lift containment that Argus didn't impose");
          await lockTarget(tx, { ...r, kind: "falcon_containment" });
          await refuseImposed(tx, me, r.integrationId, r.targetValue);
          const [pending] = await tx
            .update(responseActions)
            .set({ state: "pending", stateChangedAt: now, lastError: null })
            .where(eq(responseActions.id, id))
            .returning();
          await queue(tx, r.organizationId, id, now);
          await recordStateChange(tx, { r: pending!, subject, change: "retried", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
          return current.id;
        }
        await lockTarget(tx, r);
        const original = await liveCreated(tx, r, r.id);
        if (original) {
          const [present] = await tx
            .update(responseActions)
            .set({
              state: "active",
              origin: "already_present",
              presentFromId: original.id,
              falconAction: original.falconAction,
              severity: original.severity,
              stateChangedAt: now,
              lastError: null,
            })
            .where(eq(responseActions.id, id))
            .returning();
          await recordStateChange(tx, { r: present!, subject, change: "already_present", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
          return current.id;
        }
        const [pending] = await tx
          .update(responseActions)
          .set({ state: "pending", stateChangedAt: now, lastError: null })
          .where(eq(responseActions.id, id))
          .returning();
        await queue(tx, r.organizationId, id, now);
        await recordStateChange(tx, { r: pending!, subject, change: "retried", actor: actorOf(me), now });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },

    /**
     * Removes an Active Response Action that Case `number` created: it is Removing, and its removal is
     * queued for the worker, which deletes it in the tool (for containment, lifts it). When other Cases have "already present"
     * records relying on it, throws `RelyingCasesNotConfirmed` unless `confirmRelying`. On a Closed
     * Case only an Admin may, without reopening it; others get `CaseClosed`.
     */
    async remove(me: Membership, number: number, id: string, { confirmRelying = false }: { confirmRelying?: boolean } = {}) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        if (current.status === "closed" && !casePolicy.canReopen(me)) throw new CaseClosed();
        const { r, subject } = await lock(tx, current.id, id);
        if (r.kind === "falcon_containment_lift") throw new NotRemovable("A Lift containment can't be undone; contain the host again instead");
        if (r.origin !== "created") throw new NotRemovable("Argus didn't create this Response Action, so it can't remove it; dismiss it instead");
        if (r.state !== "active") throw new NotRemovable("Only an Active Response Action can be removed");
        if (!confirmRelying) {
          const relying = await relyingCaseIds(tx, r.id, current.id);
          if (relying.length) {
            const named = await tx
              .select({ number: cases.number, title: cases.title })
              .from(cases)
              .where(and(visibleCases(me), inArray(cases.id, relying)))
              .orderBy(asc(cases.number));
            throw new RelyingCasesNotConfirmed(named, relying.length - named.length, r.kind === "falcon_containment" ? "lift" : "remove");
          }
        }
        const [removing] = await tx
          .update(responseActions)
          .set({ state: "removing", stateChangedAt: now, lastError: null, removalRequestedById: me.userId, removalRequestedAt: now })
          .where(eq(responseActions.id, id))
          .returning();
        await queue(tx, r.organizationId, id, now, "remove");
        await recordStateChange(tx, { r: removing!, subject, change: "removal_requested", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },

    /**
     * Dismisses an Active "already present" record from Case `number`: it is Removed, and the tool is
     * left alone. Not on a Closed Case.
     */
    async dismiss(me: Membership, number: number, id: string) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const { r, subject } = await lock(tx, current.id, id);
        if (r.state !== "active" || r.origin === "created" || r.kind === "falcon_containment_lift") throw new NotDismissable();
        const [dismissed] = await tx
          .update(responseActions)
          .set({ state: "removed", stateChangedAt: now, dismissedById: me.userId, dismissedAt: now })
          .where(eq(responseActions.id, id))
          .returning();
        await recordStateChange(tx, { r: dismissed!, subject, change: "dismissed", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },
  };
  return store;
}

export type ResponseActionStore = ReturnType<typeof responseActionStore>;
