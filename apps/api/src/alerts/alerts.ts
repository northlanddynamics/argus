import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { casePolicy, visibleAlerts, visibleCases, visibleItems } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import { recordCaseAudit } from "../cases/case-audit-log";
import { actorOf, CaseClosed, CaseNotFound, insertCase, type OpenCaseInput, reopenLocked } from "../cases/cases";
import { caseRef, REOPENED_STATUS, type Resolution, SEVERITIES, type Severity, type Status } from "../cases/vocabulary";
import type { Detection } from "../crowdstrike/detections";
import type { FalconUpdate } from "../crowdstrike/falcon-updates";
import { falconCommentsOf, requestCaseCommentSync, requestCommentSync } from "../crowdstrike/comment-sync";
import { attachedComment, dismissedComment, queueWriteBacks } from "../crowdstrike/write-back";
import type { Db, Tx } from "../db/client";
import { alerts, cases, integrations, user } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership, Participant } from "../members/membership";
import {
  alertIndicators,
  alertSubjectAssets,
  bestCasesForAlerts,
  casesSharingAlert,
  linkAlertIndicators,
  newAlertsSharingCase,
  recordAlertIndicators,
  type SharedItem,
  unlinkAlertIndicators,
} from "../observables/observables";
import { publish } from "../realtime/signals";
import { alertLabel, type AlertStatus, crowdstrikeActorName, type DismissalReason, dismissalReasonLabel } from "./vocabulary";
import { queueTeamsPost, sendTeamsPosts } from "../teams/teams";

/**
 * Alerts: detections received from the Organization's Integrations. Every Member sees the Alert
 * queue, except the Alerts on Cases they can't see (`visibleAlerts`); Guests never do. Alerts arrive through the worker (`recordDetection`).
 *
 * Attaching an Alert to a Case makes it Internal, hidden from the Case's Guests, until a Member
 * shows it to them (`internal/`). It also links the Observables and Assets the Alert names to the
 * Case, and detaching it unlinks them again, except those added by hand (`observables/`). Guests see only the Alerts on their Case that aren't Internal.
 *
 * With its Integration's write-back on, attaching an Alert sets it In Progress in Falcon with a
 * comment linking to the Case, and dismissing it closes it there with the Dismissal Reason as a
 * comment, through the write-back outbox (`crowdstrike/write-back.ts`).
 *
 * Changes made to an Alert in Falcon (its status, assignee and tags there) are mirrored onto it
 * (`applyFalconUpdate`), last write wins, and recorded as CrowdStrike's: in its Case's Audit Log
 * while it is on one, else in the Organization Audit Log. They don't change its Alert Status.
 * Comments made on it in Falcon are fetched when Falcon reports a change to it, when it is attached,
 * and when it or its Case is opened, and posted into its Case's Discussion (`crowdstrike/comment-sync.ts`).
 *
 * Members open a Case from Alerts, attach them to a Case, move them between Cases, detach them and
 * dismiss them with a Dismissal Reason. An Alert is on at most one Case at a time; attaching one
 * that is on another Case moves it. Both Cases' Audit Logs record each attachment, move and
 * detachment, and the Organization Audit Log each dismissal. A Closed Case gains and loses no Alerts.
 *
 * Correlation suggests the Cases an Alert may belong with: the Cases the Member can see, in any
 * Status, linked to an Observable or Asset the Alert names that isn't on the Ignored list, ranked
 * by how many they share. A host also counts as named when the Alert names a Falcon device (`aid`)
 * recorded on it for the Alert's Integration, so a renamed host still correlates, and an account as
 * named when an account the Alert names has the same Identity Protection identity recorded for that
 * Integration (ADR 0009); Assets are never merged. It is worked out as it is read, and never attaches anything: the Member
 * attaches from a suggestion with the ordinary attach, which for a Closed Case an Admin may ask to
 * reopen it first. The same rules mark each Alert in the queue with its strongest Case, and list on a
 * Case the New Alerts sharing its Observables or Assets.
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

/**
 * A Case an Alert may belong with: the non-ignored Observables and Assets they share, and how the
 * Member may attach the Alert to it, if at all. Only Admins reopen a Closed Case to attach it there;
 * otherwise `attach` is null, as it is while the Alert is on a Closed Case itself.
 */
export type Correlation = {
  case: { number: number; title: string; status: Status; severity: Severity; restricted: boolean; assignee: { id: string; name: string } | null };
  sharedCount: number;
  shared: SharedItem[];
  attach: "attach" | "reopen_and_attach" | null;
};

/** A Case's Correlation: a New Alert sharing its non-ignored Observables or Assets. */
export type CaseCorrelation = {
  alert: {
    id: string;
    externalId: string;
    title: string;
    severity: Severity;
    host: string | null;
    userName: string | null;
    detectedAt: string | null;
    receivedAt: string;
    version: number;
    integration: { id: string; name: string };
  };
  sharedCount: number;
  shared: SharedItem[];
};

/** The most Alerts the queue shows at once, newest first. */
export const QUEUE_LIMIT = 500;

/**
 * Records a detection from `integration`: a new Alert with Status New, or, for a `CompositeId` already
 * received, the same Alert brought up to date (its Status unchanged). Its version moves on only when
 * something changed. The Observables and Assets the detection names are recorded as the Alert's.
 * Returns whether anything changed. Call it in the transaction that stores the offset.
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
  const [changed] = await tx
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
  if (changed) {
    await recordAlertIndicators(tx, { id: changed.id, organizationId: integration.organizationId, integrationId: integration.id }, detection.indicators, now);
  }
  return changed !== undefined;
}

/** A Falcon change as an Audit Log entry: what changed, from what to what. */
type FalconChange = {
  action: "alert.falcon_status_changed" | "alert.falcon_assignee_changed" | "alert.falcon_tags_changed";
  before: string | null;
  after: string | null;
};

const tagList = (tags: readonly string[]) => (tags.length ? tags.join(", ") : null);

/**
 * Applies a change made in Falcon to the Integration's Alerts it names, matched by composite ID;
 * Alerts not yet received are skipped. Each of status, assignee and tags is applied only if the
 * change is no older than the one that last set it, so changes arriving out of order never
 * overwrite newer ones. Each change applied moves the Alert's version on and is recorded in the
 * Audit Log as CrowdStrike's. Every Alert it names is also marked for a comment fetch, since a
 * comment added in Falcon may be all that changed. Call it in the transaction that stores the offset.
 */
export async function applyFalconUpdate(tx: Tx, integration: { id: string; organizationId: string }, update: FalconUpdate, now: Date) {
  const rows = await tx
    .select({
      id: alerts.id,
      externalId: alerts.externalId,
      title: alerts.title,
      version: alerts.version,
      caseId: alerts.caseId,
      falconStatus: alerts.falconStatus,
      falconStatusAt: alerts.falconStatusAt,
      falconAssignee: alerts.falconAssignee,
      falconAssigneeAt: alerts.falconAssigneeAt,
      falconTags: alerts.falconTags,
      falconTagsAt: alerts.falconTagsAt,
    })
    .from(alerts)
    .where(and(eq(alerts.integrationId, integration.id), inArray(alerts.externalId, update.externalIds)))
    .orderBy(asc(alerts.id))
    .for("update");
  /** Whether this change is no older than the one that last set a field at `at`. */
  await requestCommentSync(
    tx,
    rows.map((r) => r.id),
    now,
  );
  const newer = (at: Date | null) => at === null || update.at.getTime() >= at.getTime();
  const actor = { type: "crowdstrike" as const, name: crowdstrikeActorName(update.user) };
  let applied = false;

  for (const row of rows) {
    const set: Partial<typeof alerts.$inferInsert> = {};
    const changes: FalconChange[] = [];
    if (update.status !== undefined && newer(row.falconStatusAt)) {
      set.falconStatusAt = update.at;
      if (update.status !== row.falconStatus) {
        set.falconStatus = update.status;
        changes.push({ action: "alert.falcon_status_changed", before: row.falconStatus, after: update.status });
      }
    }
    if (update.assignee !== undefined && newer(row.falconAssigneeAt)) {
      set.falconAssigneeAt = update.at;
      if (update.assignee !== row.falconAssignee) {
        set.falconAssignee = update.assignee;
        changes.push({ action: "alert.falcon_assignee_changed", before: row.falconAssignee, after: update.assignee });
      }
    }
    if (update.tags && newer(row.falconTagsAt)) {
      set.falconTagsAt = update.at;
      const base = update.tags.set ?? row.falconTags;
      const tags = [...new Set([...base, ...update.tags.add])].filter((t) => !update.tags!.remove.includes(t));
      const same = tags.length === row.falconTags.length && tags.every((t) => row.falconTags.includes(t));
      if (!same) {
        set.falconTags = tags;
        changes.push({ action: "alert.falcon_tags_changed", before: tagList(row.falconTags), after: tagList(tags) });
      }
    }
    if (!Object.keys(set).length) continue;
    if (changes.length) Object.assign(set, { version: row.version + 1, updatedAt: now });
    await tx.update(alerts).set(set).where(eq(alerts.id, row.id));
    if (!changes.length) continue;

    applied = true;
    const target = alertLabel(row);
    for (const change of changes) {
      if (row.caseId) {
        await recordCaseAudit(tx, { organizationId: integration.organizationId, caseId: row.caseId, occurredAt: now, actor, target, ...change });
      } else {
        await recordOrgAudit(tx, { organizationId: integration.organizationId, occurredAt: now, actor, category: "alerts", target, ...change });
      }
    }
    // Falcon's view of an Alert is shown to Members only.
    if (row.caseId) await publish(tx, { kind: "case", organizationId: integration.organizationId, caseId: row.caseId, membersOnly: true });
  }
  return applied;
}

/** The most serious of `severities`, which must not be empty. */
export const highestSeverity = (severities: readonly Severity[]) =>
  SEVERITIES.find((s) => severities.includes(s)) ?? severities[0]!;

const attachedBy = alias(user, "attached_by");
const assignee = alias(user, "assignee");
const dismissedBy = alias(user, "dismissed_by");

type LockedAlert = {
  id: string;
  integrationId: string;
  externalId: string;
  title: string;
  status: AlertStatus;
  severity: Severity;
  version: number;
  caseId: string | null;
  internal: boolean;
  dismissedByName: string | null;
};

type LockedCase = { id: string; number: number; status: Status; resolution: Resolution | null; visible: boolean };

/** The Organization's Alerts among `ids`, locked for the rest of `tx` in a fixed order. */
async function lockAlerts(tx: Tx, me: Membership, ids: readonly string[]) {
  if (!ids.length) return new Map<string, LockedAlert>();
  const rows = await tx
    .select({
      id: alerts.id,
      integrationId: alerts.integrationId,
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
    .select({
      id: cases.id,
      number: cases.number,
      status: cases.status,
      resolution: cases.resolution,
      visible: sql<boolean>`(${visibleCases(me)})`,
    })
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

/** Where an Alert `me` can see is now, in words. */
function whereNow(alert: LockedAlert, onCase: LockedCase | undefined) {
  switch (alert.status) {
    case "new":
      return "is New";
    case "attached":
      return `is attached to ${caseRef(onCase!.number)}`;
    case "dismissed":
      return alert.dismissedByName ? `was dismissed by ${alert.dismissedByName}` : "was dismissed";
  }
}

/**
 * Why `alert` (selected at `version`) can't be acted on as selected, if it can't. An Alert on a Case
 * `me` can't see is not found, as if it didn't exist.
 */
function staleness(id: string, alert: LockedAlert | undefined, version: number, caseOf: Map<string, LockedCase>) {
  if (!alert || (alert.caseId && !caseOf.get(alert.caseId)?.visible)) return refusal(id, undefined, "not_found", "was not found");
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
  if (from!.status === "closed") return refusal(id, alert, "on_closed_case", `is attached to ${caseRef(from!.number)}, which is Closed`);
  return null;
}

/**
 * Attaches the selected Alerts to `target` in `tx`, moving any on another Case, and records each in
 * both Cases' Audit Logs. Each becomes Internal on `target`. Publishes the signals for whatever changed.
 * A Closed `target` refuses (`CaseClosed`), unless `reopen` asks to reopen it first, which only
 * Admins may (`NotPermitted`).
 */
async function attachIn(
  tx: Tx,
  me: Membership,
  target: { id: string; number: number; title: string },
  selection: AlertSelection,
  now: Date,
  baseUrl: string,
  { reopen = false }: { reopen?: boolean } = {},
) {
  const locked = await lockAlerts(tx, me, selection.map((s) => s.id));
  const caseOf = await lockCases(tx, me, [target.id, ...[...locked.values()].map((a) => a.caseId)]);
  const into = caseOf.get(target.id);
  if (into?.status === "closed") {
    if (!reopen) throw new CaseClosed();
    await reopenLocked(tx, me, into, now);
    caseOf.set(target.id, { ...into, status: REOPENED_STATUS, resolution: null });
  }
  const result: BulkResult = { applied: [], refused: [] };
  const touched = new Set<string>();
  /** Cases where something their Guests can see changed: an Alert they saw left, Observables or Assets came or went. */
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
      if (await unlinkAlertIndicators(tx, me, from.id, id, now)) guestsSaw.add(from.id);
      if (!alert.internal) guestsSaw.add(from.id);
    }
    if (await linkAlertIndicators(tx, me, target.id, id, now)) guestsSaw.add(target.id);
    touched.add(target.id);
    result.applied.push(id);
  }
  if (result.applied.length) {
    await queueWriteBacks(
      tx,
      me.organizationId,
      result.applied.map((id) => locked.get(id)!),
      { action: "attach", falconStatus: "in_progress", comment: attachedComment(target, baseUrl) },
      now,
    );
    // Comments already made in Falcon join the Case's Discussion.
    await requestCommentSync(tx, result.applied, now);
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
    .select({ id: cases.id, number: cases.number, title: cases.title, status: cases.status })
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

export function alertStore(deps: Pick<Deps, "db" | "clock" | "baseUrl" | "teams" | "credentials">) {
  const { db, clock, baseUrl } = deps;
  /** Attaches the selection to Case `number` (moving any on other Cases), reopening it first if asked and it is Closed. */
  const attach = (me: Membership, number: number, selection: AlertSelection, options: { reopen?: boolean } = {}) =>
    db.transaction(async (tx) => {
      const target = await caseNumbered(tx, me, number);
      return attachIn(tx, me, target, selection, clock.now(), baseUrl, options);
    });

  return {
    /** The Alert queue: the Organization's Alerts `me` can see that match `filter`, newest first. */
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
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .where(
          and(
            eq(alerts.organizationId, me.organizationId),
            visibleAlerts(me, alerts.caseId),
            filter.status ? eq(alerts.status, filter.status) : undefined,
            filter.severity ? eq(alerts.severity, filter.severity) : undefined,
            filter.integrationId ? eq(alerts.integrationId, filter.integrationId) : undefined,
            caseId ? eq(alerts.caseId, caseId) : undefined,
          ),
        )
        .orderBy(desc(alerts.receivedAt), desc(alerts.seq))
        .limit(QUEUE_LIMIT);
      const best = await bestCasesForAlerts(
        db,
        me,
        rows.map((r) => r.id),
      );
      const bestCaseIds = [...new Set([...best.values()].map((b) => b.caseId))];
      const bestCases = new Map(
        (bestCaseIds.length
          ? await db.select({ id: cases.id, number: cases.number, title: cases.title }).from(cases).where(inArray(cases.id, bestCaseIds))
          : []
        ).map((c) => [c.id, { number: c.number, title: c.title }]),
      );
      const subjects = await alertSubjectAssets(db, rows);
      return rows.map(({ integrationId, integrationName, detectedAt, receivedAt, caseNumber, caseTitle, ...row }) => {
        const top = best.get(row.id);
        const related = top && bestCases.get(top.caseId);
        return {
          ...row,
          /** The host and account Assets behind `host` and `userName`, for links to their pages. */
          ...subjects.get(row.id)!,
          integration: { id: integrationId, name: integrationName },
          /** The Case it is attached to. */
          case: caseNumber !== null && caseTitle !== null ? { number: caseNumber, title: caseTitle } : null,
          /** Correlation: its strongest visible Case other than its own, and how many other Cases it correlates with. */
          correlation: related ? { case: related, others: top.others } : null,
          detectedAt: detectedAt?.toISOString() ?? null,
          receivedAt: receivedAt.toISOString(),
        };
      });
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

    /**
     * Correlation for Case `number`: the New Alerts sharing its non-ignored Observables or Assets,
     * most shared first, and how `me` may attach them to it: `attach`, `reopen_and_attach` (an
     * Admin, on a Closed Case) or null. Throws `CaseNotFound` when `me` can't see it.
     */
    async caseCorrelations(me: Membership, number: number): Promise<{ attach: Correlation["attach"]; alerts: CaseCorrelation[] }> {
      const found = await caseNumbered(db, me, number);
      const mode = found.status !== "closed" ? "attach" : casePolicy.canReopen(me) ? "reopen_and_attach" : null;
      const shared = await newAlertsSharingCase(db, me, found.id);
      if (!shared.size) return { attach: mode, alerts: [] };
      const rows = await db
        .select({
          id: alerts.id,
          externalId: alerts.externalId,
          title: alerts.title,
          severity: alerts.severity,
          host: alerts.host,
          userName: alerts.userName,
          detectedAt: alerts.detectedAt,
          receivedAt: alerts.receivedAt,
          seq: alerts.seq,
          version: alerts.version,
          integrationId: integrations.id,
          integrationName: integrations.name,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .where(inArray(alerts.id, [...shared.keys()]));
      return {
        attach: mode,
        alerts: rows
          .map((r) => ({ row: r, items: shared.get(r.id)! }))
          .toSorted((x, y) => y.items.length - x.items.length || y.row.receivedAt.getTime() - x.row.receivedAt.getTime() || y.row.seq - x.row.seq)
          .map(({ row: { integrationId, integrationName, detectedAt, receivedAt, seq: _seq, ...row }, items }) => ({
            alert: {
              ...row,
              integration: { id: integrationId, name: integrationName },
              detectedAt: detectedAt?.toISOString() ?? null,
              receivedAt: receivedAt.toISOString(),
            },
            sharedCount: items.length,
            shared: items,
          })),
      };
    },

    /**
     * Asks for the comments of every Alert attached to Case `number` again, unless fetched just now,
     * as when someone opens the Case; the worker fetches them. Does nothing when `me` can't see it.
     */
    async refreshCommentsOnCase(me: Participant, number: number) {
      const [found] = await db
        .select({ id: cases.id })
        .from(cases)
        .where(and(visibleCases(me), eq(cases.number, number)))
        .limit(1);
      if (found) await requestCaseCommentSync(db, found.id, clock.now());
    },

    /**
     * One Alert in full, with its detection as Falcon sent it and its comments in Falcon as last
     * fetched. Opening it asks for its comments again, unless they were fetched just now; the worker
     * fetches them, and `falconComments.refreshing` says so meanwhile. Throws `AlertNotFound` for an
     * Alert on a Case `me` can't see.
     */
    async get(me: Membership, id: string) {
      const [visible] = await db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(eq(alerts.organizationId, me.organizationId), eq(alerts.id, id), visibleAlerts(me, alerts.caseId)))
        .limit(1);
      if (!visible) throw new AlertNotFound();
      await requestCommentSync(db, [id], clock.now(), { ifStale: true });
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
          attachedById: attachedBy.id,
          attachedByName: attachedBy.name,
          attachedAt: alerts.attachedAt,
          dismissalReason: alerts.dismissalReason,
          dismissalComment: alerts.dismissalComment,
          dismissedById: dismissedBy.id,
          dismissedByName: dismissedBy.name,
          dismissedAt: alerts.dismissedAt,
          falconStatus: alerts.falconStatus,
          falconAssignee: alerts.falconAssignee,
          falconTags: alerts.falconTags,
          falconCommentsDue: alerts.falconCommentsDue,
          falconCommentsSyncedAt: alerts.falconCommentsSyncedAt,
          falconCommentsError: alerts.falconCommentsError,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .leftJoin(attachedBy, eq(alerts.attachedById, attachedBy.id))
        .leftJoin(dismissedBy, eq(alerts.dismissedById, dismissedBy.id))
        .where(and(eq(alerts.organizationId, me.organizationId), eq(alerts.id, id), visibleAlerts(me, alerts.caseId)))
        .limit(1);
      if (!row) throw new AlertNotFound();
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
        /** The Observables and Assets its detection names. */
        indicators: await alertIndicators(db, row.id),
        /** Hidden from the Guests on its Case. */
        internal: row.internal,
        integration: { id: row.integrationId, name: row.integrationName },
        /** The Alert as Falcon has it, from changes made there; null fields aren't known yet. */
        falcon: { status: row.falconStatus, assignee: row.falconAssignee, tags: row.falconTags },
        /** The comments made on it in Falcon, as last fetched. */
        falconComments: await falconCommentsOf(db, row),
        /** Set while it is Attached, with the Case it is on. */
        attached:
          row.status === "attached" && row.attachedAt && row.caseNumber !== null
            ? {
                case: { number: row.caseNumber, title: row.caseTitle!, status: row.caseStatus! },
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
     * Correlation for Alert `id`: the Cases it may belong with, most shared Observables and Assets
     * first. Throws `AlertNotFound` for an Alert on a Case `me` can't see.
     */
    async correlations(me: Membership, id: string): Promise<Correlation[]> {
      const [alert] = await db
        .select({ id: alerts.id, caseId: alerts.caseId, caseStatus: cases.status })
        .from(alerts)
        .leftJoin(cases, eq(alerts.caseId, cases.id))
        .where(and(eq(alerts.organizationId, me.organizationId), eq(alerts.id, id), visibleAlerts(me, alerts.caseId)))
        .limit(1);
      if (!alert) throw new AlertNotFound();
      const shared = await casesSharingAlert(db, me, id);
      if (!shared.size) return [];
      const rows = await db
        .select({
          id: cases.id,
          number: cases.number,
          title: cases.title,
          status: cases.status,
          severity: cases.severity,
          restricted: cases.restricted,
          updatedAt: cases.updatedAt,
          assigneeId: assignee.id,
          assigneeName: assignee.name,
        })
        .from(cases)
        .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
        .where(inArray(cases.id, [...shared.keys()]));
      // An Alert on a Closed Case can't leave it, so nothing can be attached from here.
      const stuck = alert.caseStatus === "closed";
      return rows
        .map((r) => ({ row: r, items: shared.get(r.id)! }))
        .toSorted((x, y) => y.items.length - x.items.length || y.row.updatedAt.getTime() - x.row.updatedAt.getTime() || y.row.number - x.row.number)
        .map(({ row, items }) => ({
          case: {
            number: row.number,
            title: row.title,
            status: row.status,
            severity: row.severity,
            restricted: row.restricted,
            assignee: row.assigneeId && row.assigneeName ? { id: row.assigneeId, name: row.assigneeName } : null,
          },
          sharedCount: items.length,
          shared: items,
          attach: stuck ? null : row.status !== "closed" ? "attach" : casePolicy.canReopen(me) ? "reopen_and_attach" : null,
        }));
    },

    /**
     * Opens one Case from the selected Alerts and attaches those that can be. Its Severity is the
     * highest of theirs unless `input` names one. Throws `NoAlertsToAttach` when none can be, and
     * opens nothing then.
     */
    async openCase(me: Membership, input: Omit<OpenCaseInput, "severity"> & { severity?: Severity }, selection: AlertSelection) {
      const now = clock.now();
      const result = await db.transaction(async (tx) => {
        // Checked before the Case exists, so nothing opens when no Alert can be attached.
        const locked = await lockAlerts(tx, me, selection.map((x) => x.id));
        const caseOf = await lockCases(tx, me, [...locked.values()].map((a) => a.caseId));
        const checked = selection.map(({ id, version }) => ({ alert: locked.get(id), refused: attachRefusal(id, locked.get(id), version, caseOf, null) }));
        const usable = checked.flatMap(({ alert, refused }) => (alert && !refused ? [alert] : []));
        if (!usable.length) throw new NoAlertsToAttach(checked.flatMap(({ refused }) => (refused ? [refused] : [])));
        const severity = input.severity ?? highestSeverity(usable.map((a) => a.severity));
        const opened = await insertCase(tx, me, { ...input, severity }, now);
        const attached = await attachIn(tx, me, { ...opened, title: input.title }, selection, now, baseUrl);
        const announcement = { organizationId: me.organizationId, caseId: opened.id, actorId: me.userId };
        await queueTeamsPost(tx, { ...announcement, kind: "case_opened", severity, alertCount: attached.applied.length }, now);
        return { case: { number: opened.number }, ...attached };
      });
      await sendTeamsPosts(deps);
      return result;
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
        if (!alert.caseId || !from) throw new AlertRefused(refusal(id, alert, "not_attached", "isn't attached to a Case"));
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
        const unlinked = await unlinkAlertIndicators(tx, me, from.id, id, now);
        await tx.update(cases).set({ updatedAt: now }).where(eq(cases.id, from.id));
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: from.id, membersOnly: alert.internal && !unlinked });
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
            const on = caseOf.get(alert.caseId!)!;
            result.refused.push(refusal(id, alert, "attached", `is attached to ${caseRef(on.number)}; detach it before dismissing it`));
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
        await queueWriteBacks(
          tx,
          me.organizationId,
          result.applied.map((id) => locked.get(id)!),
          { action: "dismiss", falconStatus: "closed", comment: dismissedComment(me.name, dismissalReasonLabel[reason], comment) },
          now,
        );
        if (result.applied.length) await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        return result;
      });
    },
  };
}

export type AlertStore = ReturnType<typeof alertStore>;
