import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { casePolicy, NotPermitted, visibleCases, visibleItems } from "../access/policy";
import { actorOf, CaseClosed, CaseNotFound, lockCase } from "../cases/cases";
import { type CaseActor, recordCaseAudit } from "../cases/case-audit-log";
import { type CaseAuditAction, type Severity, severityLabel } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import {
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
import { secureId } from "../ids";
import { type Provider, providerCapabilities, providerLabel } from "../integrations/vocabulary";
import type { Membership, Participant } from "../members/membership";
import { NotLinked } from "../observables/observables";
import { defang, type ObservableType, observableTypeLabel } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import {
  type FalconIocAction,
  type FalconIocType,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  LIVE_STATES,
  type ResponseActionKind,
  type ResponseActionOrigin,
  type ResponseActionState,
} from "./vocabulary";

/**
 * Response Actions (ADR 0007): a Member who can work a Case sends one of its Observables to an
 * Integration whose Response Actions setting is on, as a Falcon custom IOC. The Response Action is
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
  constructor(named: { number: number; title: string }[], otherCases: number) {
    const total = named.length + otherCases;
    super(`${total === 1 ? "Another Case relies" : `${total} other Cases rely`} on this Response Action; confirm to remove it anyway`);
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

/** A Falcon custom IOC to take: `action` is Detect, or Prevent for hashes. */
export type NewResponseAction = {
  observableId: string;
  integrationId: string;
  action: FalconIocAction;
  /** Hidden from the Case's Guests. */
  internal?: boolean;
  /** Sends it even if it is on the Ignored list. */
  confirmIgnored?: boolean;
};

/**
 * Falcon custom IOCs to take at once: one per Observable per Integration. `action` is Detect, or
 * Prevent, which only hashes take: domains and IPs in a Prevent send are skipped.
 */
export type NewResponseActions = {
  observableIds: readonly string[];
  integrationIds: readonly string[];
  action: FalconIocAction;
  /** Hidden from the Case's Guests. */
  internal?: boolean;
  /** Sends those on the Ignored list too; without it, any among them refuses the whole request. */
  confirmIgnored?: boolean;
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
  observable: { id: string; type: ObservableType; value: string };
  /** What the tool was sent. */
  target: { type: string; value: string };
  falcon: { action: FalconIocAction; severity: Severity } | null;
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
  falcon: { action: FalconIocAction; severity: Severity } | null;
  /** Hidden from Guests. */
  internal: boolean;
  requestedAt: string;
  stateChangedAt: string;
  /** When the tool accepted it; never "in force now". */
  sentAt: string | null;
};

/** The Integrations a Response Action can be sent to, as the Case offers them. */
export type EligibleIntegration = { id: string; name: string; provider: string };

type Row = typeof responseActions.$inferSelect;

/** "SHA-256 e3b0…" in full, defanged where it could be clicked. */
const described = (o: { type: ObservableType; value: string }) => `${observableTypeLabel[o.type]} ${defang(o.type, o.value)}`;

/** How the Case Audit Log names a Response Action. */
export const responseActionLabel = (o: { type: ObservableType; value: string }) => `Falcon custom IOC: ${described(o)}`;

const paramsOf = (r: Pick<Row, "falconAction" | "severity">) =>
  `${falconIocActionLabel[r.falconAction!]}, severity ${severityLabel[r.severity!]}`;

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
  | "relied_on_removed";

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
};

/** The Timeline Entry's text: the Provider, never the Integration's name, and never an error. */
function timelineBody(change: StateChange, r: Row, o: { type: ObservableType; value: string }, by: string) {
  const what = described(o);
  const tool = `${providerLabel.crowdstrike} Falcon`;
  switch (change) {
    case "requested":
      return `Response Action taken by ${by}: send ${what} to ${tool} as a custom IOC (${paramsOf(r)}).`;
    case "sent":
      return `Response Action: Argus sent ${what} to ${tool} as a custom IOC (${paramsOf(r)}).`;
    case "failed":
      return `Response Action failed: Argus could not send ${what} to ${tool} as a custom IOC.`;
    case "retried":
      return `Response Action retried by ${by}: send ${what} to ${tool} as a custom IOC (${paramsOf(r)}).`;
    case "already_present":
      return `Response Action by ${by}: ${what} was already sent to ${tool} as a custom IOC by Argus, so nothing was sent again.`;
    case "in_tool":
      return `Response Action: ${what} was already in ${tool} as a custom IOC, so Argus left it unchanged.`;
    case "dismissed":
      return `Response Action dismissed by ${by}: this Case no longer records ${what} as already in ${tool}; ${tool} was left unchanged.`;
    case "removal_requested":
      return `Response Action removal asked for by ${by}: remove the custom IOC for ${what} from ${tool}.`;
    case "removal_retried":
      return `Response Action removal retried by ${by}: remove the custom IOC for ${what} from ${tool}.`;
    case "removal_failed":
      return `Response Action removal failed: Argus could not remove the custom IOC for ${what} from ${tool}.`;
    case "removed":
      return `Response Action removed: Argus removed the custom IOC for ${what} from ${tool}.`;
    case "already_gone":
      return `Response Action removed: the custom IOC for ${what} was already gone from ${tool}.`;
    case "relied_on_removed":
      return `Response Action removed: Argus removed the custom IOC for ${what} from ${tool} at the request of the Case that sent it, so this Case no longer records it as present.`;
  }
}

/** What the Case Audit Log says of a change, unless an error says it instead. */
function auditDetail(change: StateChange, r: Row) {
  const tool = `${providerLabel.crowdstrike} Falcon`;
  switch (change) {
    case "already_present":
      return "Already present: sent by Argus before; nothing was sent";
    case "in_tool":
      return `Already present in ${tool}; nothing was written`;
    case "dismissed":
      return `Dismissed; ${tool} left unchanged`;
    case "removed":
      return `Removed from ${tool}`;
    case "already_gone":
      return `Already gone from ${tool}; nothing to remove`;
    case "relied_on_removed":
      return `Removed from ${tool} by the Case that sent it`;
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
  { r, observable, change, actor, now, detail, by }: {
    r: Row;
    observable: { type: ObservableType; value: string };
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
    body: timelineBody(change, r, observable, taker?.name ?? "unknown"),
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
    target: responseActionLabel(observable),
    after: detail ?? auditDetail(change, r),
  });
  await publish(tx, { kind: "case", organizationId: r.organizationId, caseId: r.caseId, membersOnly: r.internal });
}

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
    .select({ id: t.id })
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
  return found?.id ?? null;
}

/** The Integrations in `me`'s Organization that take Falcon custom IOCs now. */
async function eligible(db: Db | Tx, organizationId: string) {
  const rows = await db
    .select({ id: integrations.id, name: integrations.name, provider: integrations.provider })
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.responseActions, true), eq(integrations.provider, "crowdstrike")))
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

/** Response Action `id` on the locked Case `caseId`, locked, with its Observable; else `ResponseActionNotFound`. */
async function lock(tx: Tx, caseId: string, id: string) {
  const [found] = await tx
    .select({ row: responseActions, type: observables.type, value: observables.value })
    .from(responseActions)
    .innerJoin(observables, eq(responseActions.observableId, observables.id))
    .where(and(eq(responseActions.id, id), eq(responseActions.caseId, caseId)))
    .for("update", { of: responseActions });
  if (!found) throw new ResponseActionNotFound();
  return { r: found.row, observable: { type: found.type as ObservableType, value: found.value } };
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
    const rows = await db
      .select({
        row: r,
        observableType: observables.type,
        observableValue: observables.value,
        integrationName: integrations.name,
        requestedByName: user.name,
        dismissedByName: dismisser.name,
        removerName: remover.name,
        original: { at: sql<Date>`coalesce(${originalAction.sentAt}, ${originalAction.createdAt})`.mapWith(originalAction.createdAt), caseId: originalAction.caseId },
        originalCase: { number: originalCaseRow.number, title: originalCaseRow.title },
      })
      .from(r)
      .innerJoin(observables, eq(r.observableId, observables.id))
      .innerJoin(integrations, eq(r.integrationId, integrations.id))
      .innerJoin(user, eq(r.createdById, user.id))
      .leftJoin(dismisser, eq(r.dismissedById, dismisser.id))
      .leftJoin(remover, eq(r.removalRequestedById, remover.id))
      .leftJoin(originalAction, eq(r.presentFromId, originalAction.id))
      .leftJoin(originalCaseRow, eq(originalAction.caseId, originalCaseRow.id))
      .where(and(eq(r.caseId, caseId), visibleItems(me, r.internal), ids ? inArray(r.id, [...ids]) : undefined))
      .orderBy(asc(r.seq));
    const insider = casePolicy.canSeeInternal(me);
    // The Cases the originals were sent from that `me` may see; the rest go unnamed.
    const originalCaseIds = [...new Set(rows.flatMap((x) => (x.original?.caseId ? [x.original.caseId] : [])))];
    const seen = new Set(
      originalCaseIds.length
        ? (await db.select({ id: cases.id }).from(cases).where(and(visibleCases(me), inArray(cases.id, originalCaseIds)))).map((c) => c.id)
        : [],
    );
    return rows.map(({ row, observableType, observableValue, integrationName, requestedByName, dismissedByName, removerName, original, originalCase }) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      observable: { id: row.observableId, type: observableType as ObservableType, value: observableValue },
      target: { type: row.targetType, value: row.targetValue },
      falcon: row.falconAction && row.severity ? { action: row.falconAction, severity: row.severity } : null,
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
          ? { case: seen.has(original.caseId) ? originalCase : null, at: original.at.toISOString() }
          : null,
      dismissedBy: row.dismissedById && dismissedByName ? { id: row.dismissedById, name: dismissedByName } : null,
      dismissedAt: row.dismissedAt?.toISOString() ?? null,
      removalRequestedBy: row.removalRequestedById && removerName ? { id: row.removalRequestedById, name: removerName } : null,
      removalRequestedAt: row.removalRequestedAt?.toISOString() ?? null,
    }));
  }

  const store = {
    /**
     * The Response Actions on Case `number` that `me` may see, and, for Members, the Integrations they
     * can send to. Throws `CaseNotFound` when `me` can't see the Case.
     */
    async list(me: Participant, number: number) {
      const caseId = await visibleCaseId(me, number);
      return {
        responseActions: await select(me, caseId),
        integrations: casePolicy.canWork(me) ? await eligible(db, me.organizationId) : [],
      };
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
        const offered = new Set((await eligible(tx, me.organizationId)).map((i) => i.id));
        if (chosen.length !== integrationIds.length || !chosen.every((i) => offered.has(i.id))) throw new IntegrationNotEligible();

        // In the order asked: what Falcon takes goes ahead, the rest are skipped with the reason.
        const skipped: Skipped[] = [];
        const accepted: { id: string; type: ObservableType; value: string; key: string; iocType: FalconIocType }[] = [];
        for (const id of observableIds) {
          const o = byId.get(id)!;
          const observable = { id, type: o.type, value: o.value };
          const iocType = falconIocType(o.type, o.key);
          if (!iocType) skipped.push({ observable, provider: "crowdstrike", reason: `Falcon takes no custom IOC for an ${observableTypeLabel[o.type]}` });
          else if (input.action === "prevent" && !falconAllowsPrevent(iocType)) {
            skipped.push({ observable, provider: "crowdstrike", reason: "Falcon can only Detect a domain or IP; Prevent is for hashes" });
          } else accepted.push({ ...o, iocType });
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

        const pairs = accepted.flatMap((o) =>
          integrationIds.map((integrationId) => ({
            o,
            target: { integrationId, kind: "falcon_ioc" as const, targetType: o.iocType, targetValue: o.key },
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
          const presentFromId = await liveCreated(tx, target);
          const [r] = await tx
            .insert(responseActions)
            .values({
              id,
              organizationId: me.organizationId,
              caseId: current.id,
              observableId: o.id,
              ...target,
              falconAction: input.action,
              severity: current.severity,
              state: presentFromId ? "active" : "pending",
              origin: presentFromId ? "already_present" : "created",
              presentFromId,
              internal: input.internal ?? false,
              createdById: me.userId,
              createdAt: now,
              stateChangedAt: now,
            })
            .returning();
          if (presentFromId) {
            await recordStateChange(tx, { r: r!, observable, change: "already_present", actor: actorOf(me), now });
          } else {
            await queue(tx, me.organizationId, id, now);
            await recordStateChange(tx, { r: r!, observable, change: "requested", actor: actorOf(me), now });
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
        falcon: row.falconAction && row.severity ? { action: row.falconAction, severity: row.severity } : null,
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
        const { r, observable } = await lock(tx, current.id, id);
        if (r.state !== "failed") throw new NotRetryable();
        if (r.removalRequestedAt) {
          if (current.status === "closed" && !casePolicy.canReopen(me)) throw new CaseClosed();
          const [removing] = await tx
            .update(responseActions)
            .set({ state: "removing", stateChangedAt: now, lastError: null, removalRequestedById: me.userId, removalRequestedAt: now })
            .where(eq(responseActions.id, id))
            .returning();
          await queue(tx, r.organizationId, id, now, "remove");
          await recordStateChange(tx, { r: removing!, observable, change: "removal_retried", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
          return current.id;
        }
        if (current.status === "closed") throw new CaseClosed();
        await lockTarget(tx, r);
        const presentFromId = await liveCreated(tx, r, r.id);
        if (presentFromId) {
          const [present] = await tx
            .update(responseActions)
            .set({ state: "active", origin: "already_present", presentFromId, stateChangedAt: now, lastError: null })
            .where(eq(responseActions.id, id))
            .returning();
          await recordStateChange(tx, { r: present!, observable, change: "already_present", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
          return current.id;
        }
        const [pending] = await tx
          .update(responseActions)
          .set({ state: "pending", stateChangedAt: now, lastError: null })
          .where(eq(responseActions.id, id))
          .returning();
        await queue(tx, r.organizationId, id, now);
        await recordStateChange(tx, { r: pending!, observable, change: "retried", actor: actorOf(me), now });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },

    /**
     * Removes an Active Response Action that Case `number` created: it is Removing, and its removal is
     * queued for the worker, which deletes it in the tool. When other Cases have "already present"
     * records relying on it, throws `RelyingCasesNotConfirmed` unless `confirmRelying`. On a Closed
     * Case only an Admin may, without reopening it; others get `CaseClosed`.
     */
    async remove(me: Membership, number: number, id: string, { confirmRelying = false }: { confirmRelying?: boolean } = {}) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number, "allow");
        if (current.status === "closed" && !casePolicy.canReopen(me)) throw new CaseClosed();
        const { r, observable } = await lock(tx, current.id, id);
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
            throw new RelyingCasesNotConfirmed(named, relying.length - named.length);
          }
        }
        const [removing] = await tx
          .update(responseActions)
          .set({ state: "removing", stateChangedAt: now, lastError: null, removalRequestedById: me.userId, removalRequestedAt: now })
          .where(eq(responseActions.id, id))
          .returning();
        await queue(tx, r.organizationId, id, now, "remove");
        await recordStateChange(tx, { r: removing!, observable, change: "removal_requested", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
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
        const { r, observable } = await lock(tx, current.id, id);
        if (r.state !== "active" || r.origin === "created") throw new NotDismissable();
        const [dismissed] = await tx
          .update(responseActions)
          .set({ state: "removed", stateChangedAt: now, dismissedById: me.userId, dismissedAt: now })
          .where(eq(responseActions.id, id))
          .returning();
        await recordStateChange(tx, { r: dismissed!, observable, change: "dismissed", actor: actorOf(me), now, by: { id: me.userId, name: me.name } });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },
  };
  return store;
}

export type ResponseActionStore = ReturnType<typeof responseActionStore>;
