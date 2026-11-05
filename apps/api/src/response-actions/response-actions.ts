import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { casePolicy, NotPermitted, visibleCases, visibleItems } from "../access/policy";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { type CaseActor, recordCaseAudit } from "../cases/case-audit-log";
import { type CaseAuditAction, type Severity, severityLabel } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { caseObservables, cases, integrations, observables, responseActionOutbox, responseActions, timelineEntries, user } from "../db/schema";
import { secureId } from "../ids";
import { providerCapabilities, providerLabel } from "../integrations/vocabulary";
import type { Membership, Participant } from "../members/membership";
import { NotLinked } from "../observables/observables";
import { defang, type ObservableType, observableTypeLabel } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import {
  type FalconIocAction,
  falconAllowsPrevent,
  falconIocActionLabel,
  falconIocType,
  type ResponseActionKind,
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

/** A Falcon custom IOC to take: `action` is Detect, or Prevent for hashes. */
export type NewResponseAction = {
  observableId: string;
  integrationId: string;
  action: FalconIocAction;
  /** Hidden from the Case's Guests. */
  internal?: boolean;
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
export type StateChange = "requested" | "sent" | "failed" | "retried";

const auditAction: Record<StateChange, CaseAuditAction> = {
  requested: "response_action.requested",
  sent: "response_action.sent",
  failed: "response_action.failed",
  retried: "response_action.retried",
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
  }
}

/**
 * Records a change to Response Action `r` on its Case, in the transaction that makes it: a Timeline
 * Entry recorded by the Member who took it (Internal when it is), a Case Audit Log entry by `actor`,
 * and the Case's signal. `detail` goes in the Audit Log only, such as an error.
 */
export async function recordStateChange(
  tx: Tx,
  { r, observable, change, actor, now, detail }: {
    r: Row;
    observable: { type: ObservableType; value: string };
    change: StateChange;
    actor: CaseActor;
    now: Date;
    detail?: string | null;
  },
) {
  const [taker] = await tx.select({ name: user.name }).from(user).where(eq(user.id, r.createdById));
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
    recordedById: r.createdById,
    recordedAt: now,
  });
  await recordCaseAudit(tx, {
    organizationId: r.organizationId,
    caseId: r.caseId,
    occurredAt: now,
    actor,
    action: auditAction[change],
    target: responseActionLabel(observable),
    after: detail ?? paramsOf(r),
  });
  await publish(tx, { kind: "case", organizationId: r.organizationId, caseId: r.caseId, membersOnly: r.internal });
}

/** Queues an attempt to carry out Response Action `id`, due now. */
const queueSend = (tx: Tx, organizationId: string, id: string, now: Date) =>
  tx.insert(responseActionOutbox).values({
    id: secureId(),
    organizationId,
    responseActionId: id,
    operation: "send",
    state: "pending",
    nextAttemptAt: now,
    createdAt: now,
  });

/** The Integrations in `me`'s Organization that take Falcon custom IOCs now. */
async function eligible(db: Db | Tx, organizationId: string) {
  const rows = await db
    .select({ id: integrations.id, name: integrations.name, provider: integrations.provider })
    .from(integrations)
    .where(and(eq(integrations.organizationId, organizationId), eq(integrations.responseActions, true), eq(integrations.provider, "crowdstrike")))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));
  return rows.filter((r) => providerCapabilities[r.provider].responseActions);
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
    const rows = await db
      .select({
        row: r,
        observableType: observables.type,
        observableValue: observables.value,
        integrationName: integrations.name,
        requestedByName: user.name,
      })
      .from(r)
      .innerJoin(observables, eq(r.observableId, observables.id))
      .innerJoin(integrations, eq(r.integrationId, integrations.id))
      .innerJoin(user, eq(r.createdById, user.id))
      .where(and(eq(r.caseId, caseId), visibleItems(me, r.internal), ids ? inArray(r.id, [...ids]) : undefined))
      .orderBy(asc(r.seq));
    const insider = casePolicy.canSeeInternal(me);
    return rows.map(({ row, observableType, observableValue, integrationName, requestedByName }) => ({
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
    }));
  }

  return {
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
     * Takes a Response Action: sends Observable `observableId`, linked to Case `number`, to Integration
     * `integrationId` as a Falcon custom IOC. Stored Pending and queued for the worker; returns it.
     */
    async take(me: Membership, number: number, input: NewResponseAction) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const id = secureId();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [linked] = await tx
          .select({ type: observables.type, value: observables.value, key: observables.matchKey })
          .from(caseObservables)
          .innerJoin(observables, eq(caseObservables.itemId, observables.id))
          .where(and(eq(caseObservables.caseId, current.id), eq(caseObservables.itemId, input.observableId), isNull(caseObservables.unlinkedAt)));
        if (!linked) throw new NotLinked("That Observable isn't linked to this Case");
        const observable = { type: linked.type as ObservableType, value: linked.value };
        const iocType = falconIocType(observable.type, linked.key);
        if (!iocType) throw new ObservableNotAccepted(`Falcon takes no custom IOC for an ${observableTypeLabel[observable.type]}`);
        if (input.action === "prevent" && !falconAllowsPrevent(iocType)) {
          throw new ObservableNotAccepted("Falcon can only Detect a domain or IP; Prevent is for hashes");
        }
        const [integration] = await tx
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.id, input.integrationId), eq(integrations.organizationId, me.organizationId)))
          .for("share");
        if (!integration || !(await eligible(tx, me.organizationId)).some((i) => i.id === integration.id)) throw new IntegrationNotEligible();

        const [r] = await tx
          .insert(responseActions)
          .values({
            id,
            organizationId: me.organizationId,
            caseId: current.id,
            observableId: input.observableId,
            integrationId: input.integrationId,
            kind: "falcon_ioc",
            targetType: iocType,
            targetValue: linked.key,
            falconAction: input.action,
            severity: current.severity,
            state: "pending",
            internal: input.internal ?? false,
            createdById: me.userId,
            createdAt: now,
            stateChangedAt: now,
          })
          .returning();
        await queueSend(tx, me.organizationId, id, now);
        await recordStateChange(tx, { r: r!, observable, change: "requested", actor: actorOf(me), now });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },

    /** Tries a Failed Response Action again: it is Pending, and queued for the worker. Not on a Closed Case. */
    async retry(me: Membership, number: number, id: string) {
      if (!casePolicy.canWork(me)) throw new NotPermitted();
      const now = clock.now();
      const caseId = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const { r, observable } = await lock(tx, current.id, id);
        if (r.state !== "failed") throw new NotRetryable();
        const [pending] = await tx
          .update(responseActions)
          .set({ state: "pending", stateChangedAt: now, lastError: null })
          .where(eq(responseActions.id, id))
          .returning();
        await queueSend(tx, r.organizationId, id, now);
        await recordStateChange(tx, { r: pending!, observable, change: "retried", actor: actorOf(me), now });
        return current.id;
      });
      return (await select(me, caseId, [id]))[0]!;
    },
  };
}

export type ResponseActionStore = ReturnType<typeof responseActionStore>;
