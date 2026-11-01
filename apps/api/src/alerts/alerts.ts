import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { visibleCases, visibleItems } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import { recordCaseAudit } from "../cases/case-audit-log";
import { actorOf, CaseClosed, CaseNotFound, insertCase, type OpenCaseInput } from "../cases/cases";
import { caseRef, SEVERITIES, type Severity, type Status } from "../cases/vocabulary";
import type { Detection } from "../crowdstrike/detections";
import type { Db, Tx } from "../db/client";
import { alerts, cases, integrations, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership, Participant } from "../members/membership";
import { publish } from "../realtime/signals";
import { alertLabel, type AlertStatus, type DismissalReason, dismissalReasonLabel } from "./vocabulary";

/**
 * Alerts: detections received from the Organization's Integrations. Every Member sees the Alert
 * queue; Guests never do. Alerts arrive through the worker (`recordDetection`).
 *
 * Attaching an Alert to a Case makes it Internal, hidden from the Case's Guests, until a Member
 * shows it to them (`internal/`). Guests see only the Alerts on their Case that aren't Internal.
 *
 * Members open a Case from Alerts, attach them to a Case, move them between Cases, detach them and
 * dismiss them with a Dismissal Reason. An Alert is on at most one Case at a time; attaching one
 * that is on another Case moves it. Both Cases' Audit Logs record each attachment, move and
 * detachment, and the Organization Audit Log each dismissal. A Closed Case gains and loses no Alerts.
 *
 * Every action names the Alerts with the version the actor last saw. Bulk actions refuse, one by
 * one, those that changed since (or that the action can't apply to) and apply the rest; acting on
 * a single Alert refuses with `AlertRefused`.
 */

/** Alerts as the actor selected them: each id with the version they saw. */
export type AlertSelection = readonly { id: string; version: number }[];

/** Why an Alert in a selection was left as it was. */
export type RefusalReason =
  /** No such Alert in the Organization. */
  | "not_found"
  /** It changed since it was selected. */
  | "changed"
  /** It is already on the Case it would be attached to. */
  | "already_on_case"
  /** It is on a Case the actor can't see. */
  | "on_hidden_case"
  /** It is on a Closed Case, which can't lose Alerts. */
  | "on_closed_case"
  /** Only an Alert that isn't on a Case is dismissed; detach it first. */
  | "attached"
  /** It is already dismissed. */
  | "dismissed"
  /** It isn't on a Case, so there is nothing to detach it from. */
  | "not_attached";

/** An Alert that an action left as it was, and why, in words (`detail` completes "<Alert> …"). */
export type Refusal = { id: string; externalId: string | null; title: string | null; reason: RefusalReason; detail: string };

/** What a bulk action did: the Alerts it applied to, and those it refused. */
export type BulkResult = { applied: string[]; refused: Refusal[] };

/** Acting on one Alert was refused. */
export class AlertRefused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(`${refusal.externalId ?? "The Alert"} ${refusal.detail}`);
    this.refusal = refusal;
  }
}

/** Opening a Case from Alerts was refused because none of them could be attached. */
export class NoAlertsToAttach extends Error {
  readonly refused: Refusal[];
  constructor(refused: Refusal[]) {
    super("None of the selected Alerts could be attached, so no Case was opened");
    this.refused = refused;
  }
}

export class AlertNotFound extends Error {
  constructor() {
    super("Alert not found");
  }
}

export type AlertFilter = { status?: AlertStatus; severity?: Severity; integrationId?: string; caseNumber?: number };

/** The most Alerts the queue shows at once, newest first. */
const QUEUE_LIMIT = 500;

/**
 * Records a detection from `integration`: a new Alert with Status New, or, for a `CompositeId` already
 * received, the same Alert brought up to date (its Status unchanged). Its version moves on only when
 * something changed. Returns whether anything did. Call it in the transaction that stores the offset.
 */
export async function recordDetection(
  tx: Tx,
  integration: { id: string; organizationId: string },
  detection: Detection,
  now: Date,
) {
  const fields = {
    kind: detection.kind,
    severity: detection.severity,
    title: detection.title,
    description: detection.description,
    host: detection.host,
    userName: detection.userName,
    detectedAt: detection.detectedAt,
    payload: detection.payload,
  };
  const changed = await tx
    .insert(alerts)
    .values({
      id: secureId(),
      organizationId: integration.organizationId,
      integrationId: integration.id,
      externalId: detection.externalId,
      status: "new",
      version: 1,
      receivedAt: now,
      updatedAt: now,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [alerts.integrationId, alerts.externalId],
      set: {
        kind: sql`excluded.kind`,
        severity: sql`excluded.severity`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        host: sql`excluded.host`,
        userName: sql`excluded.user_name`,
        detectedAt: sql`excluded.detected_at`,
        payload: sql`excluded.payload`,
        version: sql`${alerts.version} + 1`,
        updatedAt: now,
      },
      // A detection delivered again unchanged leaves its Alert as it was.
      setWhere: sql`(${alerts.kind}, ${alerts.severity}, ${alerts.title}, ${alerts.description}, ${alerts.host}, ${alerts.userName}, ${alerts.detectedAt}, ${alerts.payload})
        IS DISTINCT FROM (excluded.kind, excluded.severity, excluded.title, excluded.description, excluded.host, excluded.user_name, excluded.detected_at, excluded.payload)`,
    })
    .returning({ id: alerts.id });
  return changed.length > 0;
}


/** The most serious of `severities`, which must not be empty. */
export const highestSeverity = (severities: readonly Severity[]) =>
  SEVERITIES.find((s) => severities.includes(s)) ?? severities[0]!;

const attachedBy = alias(user, "attached_by");
const dismissedBy = alias(user, "dismissed_by");

type LockedAlert = {
  id: string;
  externalId: string;
  title: string;
  status: AlertStatus;
  severity: Severity;
  version: number;
  caseId: string | null;
  internal: boolean;
  dismissedByName: string | null;
};

type LockedCase = { id: string; number: number; status: Status; visible: boolean };

/** The Organization's Alerts among `ids`, locked for the rest of `tx` in a fixed order. */
async function lockAlerts(tx: Tx, me: Membership, ids: readonly string[]) {
  if (!ids.length) return new Map<string, LockedAlert>();
  const rows = await tx
    .select({
      id: alerts.id,
      externalId: alerts.externalId,
      title: alerts.title,
      status: alerts.status,
      severity: alerts.severity,
      version: alerts.version,
      caseId: alerts.caseId,
      internal: alerts.internal,
      dismissedById: alerts.dismissedById,
    })
    .from(alerts)
    .where(and(eq(alerts.organizationId, me.organizationId), inArray(alerts.id, [...ids])))
    .orderBy(asc(alerts.id))
    .for("update");
  const dismissers = rows.flatMap((r) => (r.dismissedById ? [r.dismissedById] : []));
  const names = new Map(
    dismissers.length
      ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, dismissers))).map((u) => [u.id, u.name])
      : [],
  );
  return new Map(
    rows.map(({ dismissedById, ...r }) => [r.id, { ...r, dismissedByName: dismissedById ? (names.get(dismissedById) ?? null) : null }]),
  );
}

/**
 * The Cases among `ids`, locked for the rest of `tx` in a fixed order (always after the Alerts, so
 * actions on overlapping Alerts and Cases can't deadlock), with whether `me` can see each.
 */
async function lockCases(tx: Tx, me: Membership, ids: readonly (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map<string, LockedCase>();
  const rows = await tx
    .select({ id: cases.id, number: cases.number, status: cases.status, visible: sql<boolean>`(${visibleCases(me)})` })
    .from(cases)
    .where(and(eq(cases.organizationId, me.organizationId), inArray(cases.id, wanted)))
    .orderBy(asc(cases.id))
    .for("update");
  return new Map(rows.map((r) => [r.id, r]));
}

const refusal = (id: string, alert: LockedAlert | undefined, reason: RefusalReason, detail: string): Refusal => ({
  id,
  externalId: alert?.externalId ?? null,
  title: alert?.title ?? null,
  reason,
  detail,
});

/** Where an Alert is now, in words, naming its Case only if `me` can see it. */
function whereNow(alert: LockedAlert, onCase: LockedCase | undefined) {
  switch (alert.status) {
    case "new":
      return "is New";
    case "attached":
      return onCase?.visible ? `is attached to ${caseRef(onCase.number)}` : "is attached to a Case you can't see";
    case "dismissed":
      return alert.dismissedByName ? `was dismissed by ${alert.dismissedByName}` : "was dismissed";
  }
}

/** Why `alert` (selected at `version`) can't be acted on as selected, if it can't. */
function staleness(id: string, alert: LockedAlert | undefined, version: number, caseOf: Map<string, LockedCase>) {
  if (!alert) return refusal(id, undefined, "not_found", "was not found");
  if (alert.version === version) return null;
  const now = whereNow(alert, alert.caseId ? caseOf.get(alert.caseId) : undefined);
  // Its Status may not have moved: then Falcon updated the detection.
  return refusal(id, alert, "changed", `changed since you selected it: ${now === "is New" ? "it was updated from Falcon" : `it ${now}`}`);
}

/** Why `alert` (selected at `version`) can't be attached to the Case `targetId`, if it can't. */
function attachRefusal(id: string, alert: LockedAlert | undefined, version: number, caseOf: Map<string, LockedCase>, targetId: string | null) {
  const stale = staleness(id, alert, version, caseOf);
  if (stale || !alert) return stale!;
  if (!alert.caseId) return null;
  const from = caseOf.get(alert.caseId);
  if (alert.caseId === targetId) return refusal(id, alert, "already_on_case", `is already attached to ${caseRef(from!.number)}`);
  if (!from?.visible) return refusal(id, alert, "on_hidden_case", "is attached to a Case you can't see");
  if (from.status === "closed") return refusal(id, alert, "on_closed_case", `is attached to ${caseRef(from.number)}, which is Closed`);
  return null;
}

/**
 * Attaches the selected Alerts to `target` in `tx`, moving any on another Case, and records each in
 * both Cases' Audit Logs. Each becomes Internal on `target`. Publishes the signals for whatever changed.
 */
async function attachIn(tx: Tx, me: Membership, target: { id: string; number: number }, selection: AlertSelection, now: Date) {
  const locked = await lockAlerts(tx, me, selection.map((s) => s.id));
  const caseOf = await lockCases(tx, me, [target.id, ...[...locked.values()].map((a) => a.caseId)]);
  if (caseOf.get(target.id)?.status === "closed") throw new CaseClosed();
  const result: BulkResult = { applied: [], refused: [] };
  const touched = new Set<string>();
  /** Cases that lost an Alert their Guests could see. */
  const guestsSaw = new Set<string>();
  for (const { id, version } of selection) {
    if (result.applied.includes(id)) continue;
    const alert = locked.get(id);
    const refused = attachRefusal(id, alert, version, caseOf, target.id);
    if (refused || !alert) {
      result.refused.push(refused!);
      continue;
    }
    const from = alert.caseId ? caseOf.get(alert.caseId) : undefined;
    await tx
      .update(alerts)
      .set({
        status: "attached",
        caseId: target.id,
        attachedById: me.userId,
        attachedAt: now,
        internal: true,
        dismissalReason: null,
        dismissalComment: null,
        dismissedById: null,
        dismissedAt: null,
        version: alert.version + 1,
        updatedAt: now,
      })
      .where(eq(alerts.id, id));
    const label = alertLabel(alert);
    await recordCaseAudit(tx, {
      organizationId: me.organizationId,
      caseId: target.id,
      occurredAt: now,
      actor: actorOf(me),
      action: "alert.attached",
      target: label,
      before: from ? caseRef(from.number) : null,
      after: caseRef(target.number),
    });
    if (from) {
      await recordCaseAudit(tx, {
        organizationId: me.organizationId,
        caseId: from.id,
        occurredAt: now,
        actor: actorOf(me),
        action: "alert.detached",
        target: label,
        before: caseRef(from.number),
        after: caseRef(target.number),
      });
      touched.add(from.id);
      if (!alert.internal) guestsSaw.add(from.id);
    }
    touched.add(target.id);
    result.applied.push(id);
  }
  if (result.applied.length) {
    await tx.update(cases).set({ updatedAt: now }).where(inArray(cases.id, [...touched]));
    await publish(tx, { kind: "alerts", organizationId: me.organizationId });
    for (const caseId of touched) {
      await publish(tx, { kind: "case", organizationId: me.organizationId, caseId, membersOnly: !guestsSaw.has(caseId) });
    }
  }
  return result;
}

/** The visible Case numbered `number`, or throws `CaseNotFound`. */
const caseNumbered = async (tx: Tx | Db, me: Membership, number: number) => {
  const [found] = await tx
    .select({ id: cases.id, number: cases.number, status: cases.status })
    .from(cases)
    .where(and(visibleCases(me), eq(cases.number, number)))
    .limit(1);
  if (!found) throw new CaseNotFound();
  return found;
};

/** Throws the refusal of a one-Alert action, if it was refused. */
const single = (result: BulkResult) => {
  if (result.refused[0]) throw new AlertRefused(result.refused[0]);
};

export function alertStore({ db, clock }: Pick<Deps, "db" | "clock">) {
  /** Attaches the selection to Case `number` (moving any on other Cases). */
  const attach = (me: Membership, number: number, selection: AlertSelection) =>
    db.transaction(async (tx) => {
      const target = await caseNumbered(tx, me, number);
      return attachIn(tx, me, target, selection, clock.now());
    });

  return {
    /** The Alert queue: the Organization's Alerts matching `filter`, newest first. */
    async list(me: Membership, filter: AlertFilter = {}) {
      let caseId: string | undefined;
      if (filter.caseNumber !== undefined) caseId = (await caseNumbered(db, me, filter.caseNumber)).id;
      const rows = await db
        .select({
          id: alerts.id,
          externalId: alerts.externalId,
          kind: alerts.kind,
          status: alerts.status,
          severity: alerts.severity,
          title: alerts.title,
          host: alerts.host,
          userName: alerts.userName,
          detectedAt: alerts.detectedAt,
          receivedAt: alerts.receivedAt,
          version: alerts.version,
          integrationId: integrations.id,
          integrationName: integrations.name,
          dismissalReason: alerts.dismissalReason,
          internal: alerts.internal,
          caseNumber: cases.number,
          caseTitle: cases.title,
          caseVisible: sql<boolean | null>`(${visibleCases(me)})`,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .where(
          and(
            eq(alerts.organizationId, me.organizationId),
            filter.status ? eq(alerts.status, filter.status) : undefined,
            filter.severity ? eq(alerts.severity, filter.severity) : undefined,
            filter.integrationId ? eq(alerts.integrationId, filter.integrationId) : undefined,
            caseId ? eq(alerts.caseId, caseId) : undefined,
          ),
        )
        .orderBy(desc(alerts.receivedAt), desc(alerts.seq))
        .limit(QUEUE_LIMIT);
      return rows.map(({ integrationId, integrationName, detectedAt, receivedAt, caseNumber, caseTitle, caseVisible, ...row }) => ({
        ...row,
        integration: { id: integrationId, name: integrationName },
        /** The Case it is attached to, unless that is a Case `me` can't see. */
        case: caseNumber !== null && caseTitle !== null && caseVisible ? { number: caseNumber, title: caseTitle } : null,
        detectedAt: detectedAt?.toISOString() ?? null,
        receivedAt: receivedAt.toISOString(),
      }));
    },

    /**
     * The Alerts attached to Case `number` that `me` can see, newest first: all of them for
     * Members, those that aren't Internal for its Guests. Throws `CaseNotFound` when `me` can't see it.
     */
    async onCase(me: Participant, number: number) {
      const [found] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(visibleCases(me), eq(cases.number, number)))
        .limit(1);
      if (!found) throw new CaseNotFound();
      const rows = await db
        .select({
          id: alerts.id,
          externalId: alerts.externalId,
          kind: alerts.kind,
          severity: alerts.severity,
          title: alerts.title,
          host: alerts.host,
          userName: alerts.userName,
          detectedAt: alerts.detectedAt,
          attachedAt: alerts.attachedAt,
          version: alerts.version,
          internal: alerts.internal,
          integrationName: integrations.name,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .where(and(eq(alerts.caseId, found.id), visibleItems(me, alerts.internal)))
        .orderBy(desc(alerts.attachedAt), desc(alerts.seq));
      return rows.map(({ detectedAt, attachedAt, integrationName, ...row }) => ({
        ...row,
        integration: { name: integrationName },
        detectedAt: detectedAt?.toISOString() ?? null,
        attachedAt: attachedAt?.toISOString() ?? null,
      }));
    },

    /** One Alert in full, with its detection as Falcon sent it. */
    async get(me: Membership, id: string) {
      const [row] = await db
        .select({
          id: alerts.id,
          externalId: alerts.externalId,
          kind: alerts.kind,
          status: alerts.status,
          severity: alerts.severity,
          title: alerts.title,
          description: alerts.description,
          host: alerts.host,
          userName: alerts.userName,
          detectedAt: alerts.detectedAt,
          receivedAt: alerts.receivedAt,
          version: alerts.version,
          payload: alerts.payload,
          internal: alerts.internal,
          integrationId: integrations.id,
          integrationName: integrations.name,
          caseNumber: cases.number,
          caseTitle: cases.title,
          caseStatus: cases.status,
          caseVisible: sql<boolean | null>`(${visibleCases(me)})`,
          attachedById: attachedBy.id,
          attachedByName: attachedBy.name,
          attachedAt: alerts.attachedAt,
          dismissalReason: alerts.dismissalReason,
          dismissalComment: alerts.dismissalComment,
          dismissedById: dismissedBy.id,
          dismissedByName: dismissedBy.name,
          dismissedAt: alerts.dismissedAt,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .leftJoin(attachedBy, eq(alerts.attachedById, attachedBy.id))
        .leftJoin(dismissedBy, eq(alerts.dismissedById, dismissedBy.id))
        .where(and(eq(alerts.organizationId, me.organizationId), eq(alerts.id, id)))
        .limit(1);
      if (!row) throw new AlertNotFound();
      const visible = row.caseNumber !== null && !!row.caseVisible;
      return {
        id: row.id,
        externalId: row.externalId,
        kind: row.kind,
        status: row.status,
        severity: row.severity,
        title: row.title,
        description: row.description,
        host: row.host,
        userName: row.userName,
        detectedAt: row.detectedAt?.toISOString() ?? null,
        receivedAt: row.receivedAt.toISOString(),
        version: row.version,
        payload: row.payload,
        /** Hidden from the Guests on its Case. */
        internal: row.internal,
        integration: { id: row.integrationId, name: row.integrationName },
        /** Set while it is Attached; `case` is null when that Case is one `me` can't see. */
        attached:
          row.status === "attached" && row.attachedAt
            ? {
                case: visible ? { number: row.caseNumber!, title: row.caseTitle!, status: row.caseStatus! } : null,
                by: row.attachedById ? { id: row.attachedById, name: row.attachedByName ?? "" } : null,
                at: row.attachedAt.toISOString(),
              }
            : null,
        dismissed:
          row.status === "dismissed" && row.dismissalReason && row.dismissedAt
            ? {
                reason: row.dismissalReason,
                comment: row.dismissalComment,
                by: row.dismissedById ? { id: row.dismissedById, name: row.dismissedByName ?? "" } : null,
                at: row.dismissedAt.toISOString(),
              }
            : null,
      };
    },

    /**
     * Opens one Case from the selected Alerts and attaches those that can be. Its Severity is the
     * highest of theirs unless `input` names one. Throws `NoAlertsToAttach` when none can be, and
     * opens nothing then.
     */
    async openCase(me: Membership, input: Omit<OpenCaseInput, "severity"> & { severity?: Severity }, selection: AlertSelection) {
      const now = clock.now();
      return db.transaction(async (tx) => {
        // Checked before the Case exists, so nothing opens when no Alert can be attached.
        const locked = await lockAlerts(tx, me, selection.map((x) => x.id));
        const caseOf = await lockCases(tx, me, [...locked.values()].map((a) => a.caseId));
        const checked = selection.map(({ id, version }) => ({ alert: locked.get(id), refused: attachRefusal(id, locked.get(id), version, caseOf, null) }));
        const usable = checked.flatMap(({ alert, refused }) => (alert && !refused ? [alert] : []));
        if (!usable.length) throw new NoAlertsToAttach(checked.flatMap(({ refused }) => (refused ? [refused] : [])));
        const severity = input.severity ?? highestSeverity(usable.map((a) => a.severity));
        const opened = await insertCase(tx, me, { ...input, severity }, now);
        const result = await attachIn(tx, me, opened, selection, now);
        return { case: { number: opened.number }, ...result };
      });
    },

    /** Attaches the selected Alerts to Case `number`, moving those on other Cases. */
    attach,

    /** Moves (or attaches) one Alert to Case `number`. */
    async move(me: Membership, id: string, version: number, number: number) {
      single(await attach(me, number, [{ id, version }]));
    },

    /** Detaches one Alert from its Case; it returns to the queue as New. */
    async detach(me: Membership, id: string, version: number) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const alert = (await lockAlerts(tx, me, [id])).get(id);
        const caseOf = await lockCases(tx, me, [alert?.caseId ?? null]);
        const stale = staleness(id, alert, version, caseOf);
        if (stale || !alert) throw new AlertRefused(stale!);
        const from = alert.caseId ? caseOf.get(alert.caseId) : undefined;
        if (!alert.caseId) throw new AlertRefused(refusal(id, alert, "not_attached", "isn't attached to a Case"));
        if (!from?.visible) throw new AlertRefused(refusal(id, alert, "on_hidden_case", "is attached to a Case you can't see"));
        if (from.status === "closed") throw new CaseClosed();
        await tx
          .update(alerts)
          .set({ status: "new", caseId: null, attachedById: null, attachedAt: null, version: alert.version + 1, updatedAt: now })
          .where(eq(alerts.id, id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: from.id,
          occurredAt: now,
          actor: actorOf(me),
          action: "alert.detached",
          target: alertLabel(alert),
          before: caseRef(from.number),
        });
        await tx.update(cases).set({ updatedAt: now }).where(eq(cases.id, from.id));
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: from.id, membersOnly: alert.internal });
      });
    },

    /**
     * Dismisses the selected Alerts with `reason`, each recorded in the Organization Audit Log.
     * Alerts on a Case are refused: detach them first.
     */
    async dismiss(me: Membership, selection: AlertSelection, reason: DismissalReason, comment: string | null) {
      const now = clock.now();
      return db.transaction(async (tx) => {
        const locked = await lockAlerts(tx, me, selection.map((s) => s.id));
        const caseOf = await lockCases(tx, me, [...locked.values()].map((a) => a.caseId));
        const result: BulkResult = { applied: [], refused: [] };
        for (const { id, version } of selection) {
          const alert = locked.get(id);
          const stale = staleness(id, alert, version, caseOf);
          if (stale || !alert) {
            result.refused.push(stale!);
            continue;
          }
          if (result.applied.includes(id)) continue;
          if (alert.status === "dismissed") {
            result.refused.push(refusal(id, alert, "dismissed", "is already dismissed"));
            continue;
          }
          if (alert.status === "attached") {
            const on = alert.caseId ? caseOf.get(alert.caseId) : undefined;
            const where = on?.visible ? caseRef(on.number) : "a Case you can't see";
            result.refused.push(refusal(id, alert, "attached", `is attached to ${where}; detach it before dismissing it`));
            continue;
          }
          await tx
            .update(alerts)
            .set({
              status: "dismissed",
              dismissalReason: reason,
              dismissalComment: comment,
              dismissedById: me.userId,
              dismissedAt: now,
              version: alert.version + 1,
              updatedAt: now,
            })
            .where(eq(alerts.id, id));
          await recordOrgAudit(tx, {
            organizationId: me.organizationId,
            occurredAt: now,
            actor: { type: "member", id: me.userId, name: me.name },
            category: "alerts",
            action: "alert.dismissed",
            target: alertLabel(alert),
            after: comment ? `${dismissalReasonLabel[reason]}: ${comment}` : dismissalReasonLabel[reason],
          });
          result.applied.push(id);
        }
        if (result.applied.length) await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        return result;
      });
    },
  };
}

export type AlertStore = ReturnType<typeof alertStore>;
