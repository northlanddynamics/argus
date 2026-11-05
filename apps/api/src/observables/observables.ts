import { and, asc, desc, eq, inArray, isNull, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { casePolicy, isGuest, type MemberActor, NotPermitted, organizationPolicy, visibleAlerts, visibleCases } from "../access/policy";
import { recordOrgAudit } from "../audit/org-audit-log";
import type { AlertStatus } from "../alerts/vocabulary";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { CaseAuditAction, Severity, Status } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import {
  alertAssets,
  alertObservables,
  alerts,
  assets,
  caseAssets,
  caseObservables,
  cases,
  ignoredObservables,
  observables,
  user,
} from "../db/schema";
import { secureId } from "../ids";
import type { Membership, Participant } from "../members/membership";
import { publish } from "../realtime/signals";
import {
  type AssetType,
  assetTypeLabel,
  type Normalised,
  normaliseAsset,
  normaliseObservable,
  type ObservableType,
  observableExpected,
  observableTypeLabel,
} from "./vocabulary";

/**
 * Observables and Assets on a Case. Each is held once per Organization, keyed by its type and
 * normalised value, and linked to every Case it appears in; a Case shows the other Cases each one
 * is also linked to, among those the actor can see.
 *
 * Anyone who can see a Case links and unlinks them while it isn't Closed. Both are recorded in the
 * Case Audit Log, and an unlinked item's link is kept (ADR 0003). Linking something already linked
 * changes nothing.
 *
 * Alerts name Observables and Assets too (`crowdstrike/indicators.ts`): each is added to the
 * Organization as its detection arrives (`recordAlertIndicators`). Attaching an Alert links what it
 * names to the Case, unless already linked (`linkAlertIndicators`); detaching it unlinks those links
 * again, but never one added by hand or one another Alert on the Case still names
 * (`unlinkAlertIndicators`). Linking by hand something an Alert linked makes it a hand-added link.
 *
 * Admins keep the Organization's Ignored Observables list, which takes Assets too: items too common
 * to mean anything, which never drive a Correlation. Ignoring one changes nothing else about it.
 * Each add and remove is recorded in the Organization Audit Log; removing ends the entry and keeps
 * it (ADR 0003).
 */

/** The value isn't a valid one of its type. */
export class InvalidValue extends Error {}
export class NotLinked extends Error {}
/** No such Observable or Asset, or none the actor may see. */
export class ItemNotFound extends Error {}

type Person = { id: string; name: string };
/** Another Case the item is linked to. */
export type SeenIn = { number: number; title: string };
export type LinkedView<Type extends string> = {
  /** The Observable or Asset, the same on every Case it is linked to. */
  id: string;
  type: Type;
  value: string;
  linkedBy: Person;
  linkedAt: string;
  /**
   * Set when attaching an Alert linked it rather than someone by hand: that Alert, which Guests
   * aren't told about (`alert` is null for them).
   */
  fromAlert: { alert: { id: string; externalId: string; title: string } | null } | null;
  /** Other Cases it is linked to that the actor can see, newest first. */
  seenIn: SeenIn[];
};

/** A Case an Observable or Asset is linked to, on its page. */
export type ItemCase = {
  number: number;
  title: string;
  status: Status;
  severity: Severity;
  restricted: boolean;
  assignee: Person | null;
  /** When it was linked to this Case. */
  linkedAt: string;
};

/** An Alert that names an Observable or Asset, on its page. */
export type ItemAlert = {
  id: string;
  externalId: string;
  title: string;
  severity: Severity;
  status: AlertStatus;
  host: string | null;
  /** When Falcon raised the detection, else when Argus received it. */
  seenAt: string;
  /** The Case it is attached to, unless that is a Case the actor can't see. */
  case: { number: number; title: string } | null;
};

/**
 * An Observable or Asset's page: everything Argus knows about it that the actor may see. First and
 * last seen come from those links alone, so a Case the actor can't see never shifts them.
 */
export type ItemDetail<Type extends string> = {
  id: string;
  type: Type;
  value: string;
  firstSeen: string;
  lastSeen: string;
  /** The Cases it is linked to that the actor can see, most recently linked first. */
  cases: ItemCase[];
  /** The Alerts naming it that the actor can see, in any Alert Status, newest first. Never for Guests. */
  alerts: ItemAlert[];
  /** Set while it is on the Ignored list: who added it and when. Never told to Guests. */
  ignored: IgnoredMark | null;
};

/** Who put an item on the Ignored list, and when. */
export type IgnoredMark = { by: Person; at: string };

/** An entry on the Ignored list, as Admin settings show it. */
export type IgnoredEntry = {
  kind: "observable" | "asset";
  /** The Observable or Asset. */
  id: string;
  type: string;
  value: string;
  by: Person;
  at: string;
};

type Kind<Type extends string> = {
  /** Its name on the Ignored list. */
  name: "observable" | "asset";
  items: typeof observables;
  links: typeof caseObservables;
  alertLinks: typeof alertObservables;
  /** Its name in errors, such as "Observable". */
  noun: string;
  normalise: (type: Type, raw: string) => Normalised | null;
  invalid: (type: Type) => string;
  label: (type: Type) => string;
  linked: CaseAuditAction;
  unlinked: CaseAuditAction;
  /** The Ignored list's column naming this kind of item. */
  ignoredItem: typeof ignoredObservables.observableId | typeof ignoredObservables.assetId;
};

function heldOnceStore<Type extends string>({ db, clock }: { db: Db; clock: Clock }, kind: Kind<Type>) {
  const { items, links } = kind;

  /** Signals every Case `itemId` is linked to, so each one's "seen in" refreshes. */
  const announce = async (tx: Tx, me: Membership, itemId: string, caseId: string) => {
    const others = await tx
      .select({ caseId: links.caseId })
      .from(links)
      .where(and(eq(links.itemId, itemId), isNull(links.unlinkedAt), ne(links.caseId, caseId)));
    for (const id of new Set([caseId, ...others.map((o) => o.caseId)])) {
      await publish(tx, { kind: "case", organizationId: me.organizationId, caseId: id });
    }
  };

  const describe = (type: Type, value: string) => `${kind.label(type)} ${value}`;

  async function visibleCaseId(me: Participant, number: number) {
    const [found] = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(visibleCases(me), eq(cases.number, number)))
      .limit(1);
    if (!found) throw new CaseNotFound();
    return found.id;
  }

  /** What is linked to Case `number`, in the order it was linked. Throws `CaseNotFound` if `me` can't see it. */
  async function list(me: Participant, number: number): Promise<LinkedView<Type>[]> {
      const id = await visibleCaseId(me, number);
      const rows = await db
        .select({
          id: items.id,
          type: items.type,
          value: items.value,
          linkedById: user.id,
          linkedByName: user.name,
          linkedAt: links.linkedAt,
          alertId: alerts.id,
          alertExternalId: alerts.externalId,
          alertTitle: alerts.title,
        })
        .from(links)
        .innerJoin(items, eq(links.itemId, items.id))
        .innerJoin(user, eq(links.linkedById, user.id))
        .leftJoin(alerts, eq(links.alertId, alerts.id))
        .where(and(eq(links.caseId, id), isNull(links.unlinkedAt)))
        .orderBy(asc(links.linkedAt), asc(links.seq));
      // Guests never learn which other Cases an item is on.
      const seen = rows.length && casePolicy.canSeeCorrelation(me)
        ? await db
            .select({ itemId: links.itemId, number: cases.number, title: cases.title })
            .from(links)
            .innerJoin(cases, eq(links.caseId, cases.id))
            .where(
              and(
                inArray(
                  links.itemId,
                  rows.map((r) => r.id),
                ),
                isNull(links.unlinkedAt),
                ne(cases.id, id),
                visibleCases(me),
              ),
            )
            .orderBy(desc(cases.number))
        : [];
      return rows.map((r) => ({
        id: r.id,
        type: r.type as Type,
        value: r.value,
        linkedBy: { id: r.linkedById, name: r.linkedByName },
        linkedAt: r.linkedAt.toISOString(),
        seenIn: seen.filter((s) => s.itemId === r.id).map((s) => ({ number: s.number, title: s.title })),
        fromAlert:
          r.alertId === null
            ? null
            : { alert: !casePolicy.canSeeAlerts(me) ? null : { id: r.alertId, externalId: r.alertExternalId!, title: r.alertTitle! } },
      }));
  }

  const assignee = alias(user, "assignee");

  /**
   * Item `itemId`'s page as `me` may see it. Members see it when it is linked to a Case they can see
   * or named by an Alert they can see; Guests only when it is on a Case they've been granted, and
   * never the Alerts. Throws `ItemNotFound` otherwise, so its existence doesn't leak.
   */
  async function detail(me: Participant, itemId: string): Promise<ItemDetail<Type>> {
    const [item] = await db
      .select({ id: items.id, type: items.type, value: items.value })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.organizationId, me.organizationId)));
    if (!item) throw new ItemNotFound(`${kind.noun} not found`);
    const caseRows = await db
      .select({
        number: cases.number,
        title: cases.title,
        status: cases.status,
        severity: cases.severity,
        restricted: cases.restricted,
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        linkedAt: links.linkedAt,
      })
      .from(links)
      .innerJoin(cases, eq(links.caseId, cases.id))
      .leftJoin(assignee, eq(cases.assigneeId, assignee.id))
      .where(and(eq(links.itemId, itemId), isNull(links.unlinkedAt), visibleCases(me)))
      .orderBy(desc(links.linkedAt), desc(cases.number));
    const seenAt = sql<Date>`coalesce(${alerts.detectedAt}, ${alerts.receivedAt})`.mapWith(alerts.receivedAt);
    const alertRows = isGuest(me) || !casePolicy.canSeeAlerts(me)
      ? []
      : await db
          .select({
            id: alerts.id,
            externalId: alerts.externalId,
            title: alerts.title,
            severity: alerts.severity,
            status: alerts.status,
            host: alerts.host,
            seenAt,
            caseNumber: cases.number,
            caseTitle: cases.title,
          })
          .from(kind.alertLinks)
          .innerJoin(alerts, eq(kind.alertLinks.alertId, alerts.id))
          // Only an Alert on no Case or on a visible one gets here, so its Case can be shown.
          .leftJoin(cases, eq(alerts.caseId, cases.id))
          .where(and(eq(kind.alertLinks.itemId, itemId), visibleAlerts(me, alerts.caseId)))
          .orderBy(desc(seenAt), desc(alerts.seq));
    if (!caseRows.length && !alertRows.length) throw new ItemNotFound(`${kind.noun} not found`);
    const ignored = isGuest(me) ? null : await ignoredMark(db, kind.ignoredItem, itemId);
    const times = [...caseRows.map((c) => c.linkedAt.getTime()), ...alertRows.map((a) => a.seenAt.getTime())];
    return {
      id: item.id,
      type: item.type as Type,
      value: item.value,
      firstSeen: new Date(Math.min(...times)).toISOString(),
      lastSeen: new Date(Math.max(...times)).toISOString(),
      cases: caseRows.map(({ assigneeId, assigneeName, linkedAt, ...c }) => ({
        ...c,
        assignee: assigneeId && assigneeName ? { id: assigneeId, name: assigneeName } : null,
        linkedAt: linkedAt.toISOString(),
      })),
      alerts: alertRows.map(({ caseNumber, caseTitle, seenAt: at, ...a }) => ({
        ...a,
        seenAt: at.toISOString(),
        case: caseNumber !== null && caseTitle !== null ? { number: caseNumber, title: caseTitle } : null,
      })),
      ignored,
    };
  }

  /** The Organization's item `itemId`, locked; throws `ItemNotFound` if there's none. */
  async function lockItem(tx: Tx, me: Membership, itemId: string) {
    const [item] = await tx
      .select({ id: items.id, type: items.type, value: items.value })
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.organizationId, me.organizationId)))
      .for("update");
    if (!item) throw new ItemNotFound(`${kind.noun} not found`);
    return item;
  }

  /**
   * Puts item `itemId` on the Ignored list, or takes it off (`ignored` false). Admins only. Doing what
   * is already so changes nothing; returns whether anything changed.
   */
  async function setIgnored(me: Membership, itemId: string, ignored: boolean) {
    if (!organizationPolicy.canManageIgnoredObservables(me)) throw new NotPermitted();
    const now = clock.now();
    return db.transaction(async (tx) => {
      const item = await lockItem(tx, me, itemId);
      const [entry] = await tx
        .select({ id: ignoredObservables.id })
        .from(ignoredObservables)
        .where(and(eq(kind.ignoredItem, itemId), isNull(ignoredObservables.endedAt)));
      if (!!entry === ignored) return false;
      if (entry) {
        await tx.update(ignoredObservables).set({ endedById: me.userId, endedAt: now }).where(eq(ignoredObservables.id, entry.id));
      } else {
        await tx.insert(ignoredObservables).values({
          id: secureId(),
          organizationId: me.organizationId,
          [kind.name === "observable" ? "observableId" : "assetId"]: itemId,
          ignoredById: me.userId,
          ignoredAt: now,
        });
      }
      await recordOrgAudit(tx, {
        organizationId: me.organizationId,
        occurredAt: now,
        actor: { type: "member", id: me.userId, name: me.name },
        category: "ignored-observables",
        action: ignored ? "ignored_observable.added" : "ignored_observable.removed",
        target: describe(item.type as Type, item.value),
      });
      // Its page and, later, Correlations depend on it.
      await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      return true;
    });
  }

  /**
   * Links the Organization's `type` item with this value to Case `current` (locked by `lockCase`),
   * first adding it to the Organization if it's new. `linked` is false if it was already linked.
   */
  async function linkTo(tx: Tx, me: Membership, current: { id: string }, type: Type, normalised: Normalised, now: Date) {
    await tx
      .insert(items)
      .values({
        id: secureId(),
        organizationId: me.organizationId,
        type,
        value: normalised.value,
        matchKey: normalised.key,
        createdAt: now,
      })
      .onConflictDoNothing();
    const [item] = await tx
      .select({ id: items.id, value: items.value })
      .from(items)
      .where(and(eq(items.organizationId, me.organizationId), eq(items.type, type), eq(items.matchKey, normalised.key)));
    if (!item) throw new Error(`The ${kind.noun} was neither added nor found`);
    const [already] = await tx
      .select({ id: links.id, alertId: links.alertId })
      .from(links)
      .where(and(eq(links.caseId, current.id), eq(links.itemId, item.id), isNull(links.unlinkedAt)));
    if (already && !already.alertId) return { itemId: item.id, linked: false };
    // Linked by an Alert: it becomes a hand-added link, which detaching the Alert leaves.
    if (already) await tx.update(links).set({ unlinkedById: me.userId, unlinkedAt: now }).where(eq(links.id, already.id));
    await tx.insert(links).values({
      id: secureId(),
      organizationId: me.organizationId,
      caseId: current.id,
      itemId: item.id,
      linkedById: me.userId,
      linkedAt: now,
    });
    await recordCaseAudit(tx, {
      organizationId: me.organizationId,
      caseId: current.id,
      occurredAt: now,
      actor: actorOf(me),
      action: kind.linked,
      target: describe(type, item.value),
    });
    await announce(tx, me, item.id, current.id);
    return { itemId: item.id, linked: true };
  }

  return {
    list,
    detail,
    setIgnored,

    /**
     * Links the Organization's `type` item with this value to the Case, first adding it to the
     * Organization if it's new. `linked` is false if it was already linked, and nothing changed.
     * Throws `InvalidValue` if the value isn't a valid `type`.
     */
    async link(me: Membership, number: number, type: Type, raw: string) {
      const normalised = kind.normalise(type, raw);
      if (!normalised) throw new InvalidValue(kind.invalid(type));
      const now = clock.now();
      const { itemId, linked } = await db.transaction(async (tx) => linkTo(tx, me, await lockCase(tx, me, number), type, normalised, now));
      const view = (await list(me, number)).find((v) => v.id === itemId);
      if (!view) throw new NotLinked(`${kind.noun} not linked to this Case`);
      return { view, linked };
    },

    /**
     * Links each of `values` to the Case as `link` does, all at once or, if one isn't valid (throwing
     * `InvalidValue`), none. Returns how many were linked and how many already were.
     */
    async linkAll(me: Membership, number: number, values: readonly { type: Type; value: string }[]) {
      const normalised = values.map(({ type, value }) => {
        const found = kind.normalise(type, value);
        if (!found) throw new InvalidValue(`${kind.invalid(type)}: ${value}`);
        return { type, ...found };
      });
      const now = clock.now();
      return db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        let linked = 0;
        for (const { type, ...value } of normalised) {
          if ((await linkTo(tx, me, current, type, value, now)).linked) linked++;
        }
        return { linked, alreadyLinked: normalised.length - linked };
      });
    },

    /** Unlinks item `itemId` from the Case; throws `NotLinked` if it isn't linked. Returns what is still linked. */
    async unlink(me: Membership, number: number, itemId: string) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
        const [link] = await tx
          .select({ id: links.id, type: items.type, value: items.value })
          .from(links)
          .innerJoin(items, eq(links.itemId, items.id))
          .where(and(eq(links.caseId, current.id), eq(links.itemId, itemId), isNull(links.unlinkedAt)));
        if (!link) throw new NotLinked(`${kind.noun} not linked to this Case`);
        await tx.update(links).set({ unlinkedById: me.userId, unlinkedAt: now }).where(eq(links.id, link.id));
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor: actorOf(me),
          action: kind.unlinked,
          target: describe(link.type as Type, link.value),
        });
        await announce(tx, me, itemId, current.id);
      });
      return list(me, number);
    },
  };
}

const observableKind: Kind<ObservableType> = {
  name: "observable",
  items: observables,
  links: caseObservables,
  alertLinks: alertObservables,
  noun: "Observable",
  normalise: normaliseObservable,
  invalid: observableExpected,
  label: (type) => observableTypeLabel[type],
  linked: "observable.linked",
  unlinked: "observable.unlinked",
  ignoredItem: ignoredObservables.observableId,
};

const assetKind: Kind<AssetType> = {
  name: "asset",
  // Built by the same function as Observables' tables (`db/argus-schema.ts`), so the same shape.
  items: assets,
  links: caseAssets,
  alertLinks: alertAssets,
  noun: "Asset",
  normalise: normaliseAsset,
  invalid: (type) => `${assetTypeLabel[type]} needs an identifier`,
  label: (type) => assetTypeLabel[type],
  linked: "asset.linked",
  unlinked: "asset.unlinked",
  ignoredItem: ignoredObservables.assetId,
};

export const observableStore = (deps: { db: Db; clock: Clock }) => heldOnceStore(deps, observableKind);
export const assetStore = (deps: { db: Db; clock: Clock }) => heldOnceStore(deps, assetKind);

export type ObservableStore = ReturnType<typeof observableStore>;
export type AssetStore = ReturnType<typeof assetStore>;

/* The Ignored list. */

/** Who put item `itemId` on the Ignored list and when, if it is on it. */
async function ignoredMark(db: Db | Tx, column: Kind<string>["ignoredItem"], itemId: string): Promise<IgnoredMark | null> {
  const [entry] = await db
    .select({ byId: user.id, byName: user.name, at: ignoredObservables.ignoredAt })
    .from(ignoredObservables)
    .innerJoin(user, eq(ignoredObservables.ignoredById, user.id))
    .where(and(eq(column, itemId), isNull(ignoredObservables.endedAt)));
  return entry ? { by: { id: entry.byId, name: entry.byName }, at: entry.at.toISOString() } : null;
}

/**
 * The Organization's Ignored list: every Observable and Asset on it, most recently added first.
 * Members see it; Guests can't.
 */
export const ignoredObservableStore = ({ db }: { db: Db }) => ({
  async list(me: Participant): Promise<IgnoredEntry[]> {
    if (isGuest(me)) throw new NotPermitted();
    const rows = await Promise.all(
      KINDS.map(async (kind) =>
        (
          await db
            .select({
              id: kind.items.id,
              type: kind.items.type,
              value: kind.items.value,
              byId: user.id,
              byName: user.name,
              at: ignoredObservables.ignoredAt,
              seq: ignoredObservables.seq,
            })
            .from(ignoredObservables)
            .innerJoin(kind.items, eq(kind.ignoredItem, kind.items.id))
            .innerJoin(user, eq(ignoredObservables.ignoredById, user.id))
            .where(and(eq(ignoredObservables.organizationId, me.organizationId), isNull(ignoredObservables.endedAt)))
        ).map((r) => ({ ...r, kind: kind.name })),
      ),
    );
    return rows
      .flat()
      .toSorted((x, y) => y.at.getTime() - x.at.getTime() || y.seq - x.seq)
      .map((r) => ({ kind: r.kind, id: r.id, type: r.type, value: r.value, by: { id: r.byId, name: r.byName }, at: r.at.toISOString() }));
  },
});

export type IgnoredObservableStore = ReturnType<typeof ignoredObservableStore>;

/* Observables and Assets that Alerts name. */

/** Both kinds, to work on either alike: their tables have the same shape. */
const KINDS = [observableKind, assetKind] as unknown as readonly [Kind<string>, Kind<string>];

/**
 * Adds what Alert `alertId`'s detection names to its Organization (once each, as hand-added ones
 * are) and records that the Alert names them. What an earlier version of the detection named stays
 * recorded. Call it in the transaction that records the detection.
 */
export async function recordAlertIndicators(
  tx: Tx,
  alert: { id: string; organizationId: string },
  indicators: { observables: readonly (Normalised & { type: ObservableType })[]; assets: readonly (Normalised & { type: AssetType })[] },
  now: Date,
) {
  const lists = [indicators.observables, indicators.assets] as const;
  for (const [i, kind] of KINDS.entries()) {
    const found: readonly (Normalised & { type: string })[] = lists[i as 0 | 1];
    if (!found.length) continue;
    const { items, alertLinks } = kind;
    await tx
      .insert(items)
      .values(found.map((f) => ({ id: secureId(), organizationId: alert.organizationId, type: f.type, value: f.value, matchKey: f.key, createdAt: now })))
      .onConflictDoNothing();
    const held = await tx
      .select({ id: items.id, type: items.type, matchKey: items.matchKey })
      .from(items)
      .where(and(eq(items.organizationId, alert.organizationId), inArray(items.matchKey, [...new Set(found.map((f) => f.key))])));
    const idOf = new Map(held.map((h) => [`${h.type}\u0000${h.matchKey}`, h.id]));
    const ids = found.flatMap((f) => idOf.get(`${f.type}\u0000${f.key}`) ?? []);
    await tx
      .insert(alertLinks)
      .values(ids.map((itemId) => ({ organizationId: alert.organizationId, alertId: alert.id, itemId })))
      .onConflictDoNothing();
  }
}

/** What Alert `alertId` names, in the order its detection first named them. */
export async function alertIndicators(db: Db | Tx, alertId: string) {
  const [found, assetsFound] = await Promise.all(
    KINDS.map(({ items, alertLinks }) =>
      db
        .select({ id: items.id, type: items.type, value: items.value })
        .from(alertLinks)
        .innerJoin(items, eq(alertLinks.itemId, items.id))
        .where(eq(alertLinks.alertId, alertId))
        .orderBy(asc(alertLinks.seq)),
    ),
  );
  return {
    observables: found!.map((o) => ({ ...o, type: o.type as ObservableType })),
    assets: assetsFound!.map((a) => ({ ...a, type: a.type as AssetType })),
  };
}

/** Signals the other Cases `itemIds` are linked to, whose "seen in" just changed. */
async function announceOthers(tx: Tx, kind: Kind<string>, organizationId: string, itemIds: string[], caseId: string) {
  if (!itemIds.length) return;
  const others = await tx
    .selectDistinct({ caseId: kind.links.caseId })
    .from(kind.links)
    .where(and(inArray(kind.links.itemId, itemIds), isNull(kind.links.unlinkedAt), ne(kind.links.caseId, caseId)));
  for (const o of others) await publish(tx, { kind: "case", organizationId, caseId: o.caseId });
}

/**
 * Links to Case `caseId` what Alert `alertId` names and isn't linked yet, as linked by `me` through
 * that Alert, each recorded in the Case Audit Log. Call it in the transaction that attaches the
 * Alert, with the Case locked. Returns whether anything was linked.
 */
export async function linkAlertIndicators(tx: Tx, me: Membership, caseId: string, alertId: string, now: Date) {
  let any = false;
  for (const kind of KINDS) {
    const { items, links, alertLinks } = kind;
    const named = await tx
      .select({ id: items.id, type: items.type, value: items.value })
      .from(alertLinks)
      .innerJoin(items, eq(alertLinks.itemId, items.id))
      .leftJoin(links, and(eq(links.itemId, items.id), eq(links.caseId, caseId), isNull(links.unlinkedAt)))
      .where(and(eq(alertLinks.alertId, alertId), isNull(links.id)))
      .orderBy(asc(alertLinks.seq));
    if (!named.length) continue;
    await tx.insert(links).values(
      named.map((item) => ({
        id: secureId(),
        organizationId: me.organizationId,
        caseId,
        itemId: item.id,
        linkedById: me.userId,
        linkedAt: now,
        alertId,
      })),
    );
    for (const item of named) {
      await recordCaseAudit(tx, {
        organizationId: me.organizationId,
        caseId,
        occurredAt: now,
        actor: actorOf(me),
        action: kind.linked,
        target: `${kind.label(item.type)} ${item.value}`,
      });
    }
    await announceOthers(tx, kind, me.organizationId, named.map((n) => n.id), caseId);
    any = true;
  }
  return any;
}

/**
 * Undoes `linkAlertIndicators` as Alert `alertId` leaves Case `caseId`: what it linked is unlinked,
 * each recorded in the Case Audit Log, unless another Alert on the Case names it too, which then
 * holds the link instead. What was linked by hand stays. Call it in the transaction that detaches
 * (or moves) the Alert, after it has left the Case. Returns whether anything was unlinked.
 */
export async function unlinkAlertIndicators(tx: Tx, me: Membership, caseId: string, alertId: string, now: Date) {
  let any = false;
  for (const kind of KINDS) {
    const { items, links, alertLinks } = kind;
    const held = await tx
      .select({ id: links.id, itemId: items.id, type: items.type, value: items.value })
      .from(links)
      .innerJoin(items, eq(links.itemId, items.id))
      .where(and(eq(links.caseId, caseId), eq(links.alertId, alertId), isNull(links.unlinkedAt)))
      .orderBy(asc(links.seq));
    if (!held.length) continue;
    const stillNamed = await tx
      .select({ itemId: alertLinks.itemId, alertId: alertLinks.alertId })
      .from(alertLinks)
      .innerJoin(alerts, eq(alertLinks.alertId, alerts.id))
      .where(
        and(
          inArray(
            alertLinks.itemId,
            held.map((h) => h.itemId),
          ),
          eq(alerts.caseId, caseId),
          ne(alerts.id, alertId),
        ),
      )
      .orderBy(asc(alertLinks.seq));
    const unlinked: string[] = [];
    for (const link of held) {
      const other = stillNamed.find((s) => s.itemId === link.itemId);
      if (other) {
        await tx.update(links).set({ alertId: other.alertId }).where(eq(links.id, link.id));
        continue;
      }
      await tx.update(links).set({ unlinkedById: me.userId, unlinkedAt: now }).where(eq(links.id, link.id));
      await recordCaseAudit(tx, {
        organizationId: me.organizationId,
        caseId,
        occurredAt: now,
        actor: actorOf(me),
        action: kind.unlinked,
        target: `${kind.label(link.type)} ${link.value}`,
      });
      unlinked.push(link.itemId);
    }
    await announceOthers(tx, kind, me.organizationId, unlinked, caseId);
    any ||= unlinked.length > 0;
  }
  return any;
}

/* Correlation. */

/** An Observable or Asset an Alert shares with a Case. */
export type SharedItem =
  | { kind: "observable"; id: string; type: ObservableType; value: string }
  | { kind: "asset"; id: string; type: AssetType; value: string };

/**
 * Correlation for Alert `alertId`: each Case `me` can see, in any Status and other than `exceptCaseId`
 * (the Case it is on), linked to an Observable or Asset the Alert names that isn't on the Ignored
 * list, with those items in the order the Alert first named them, Observables first.
 */
export async function casesSharingAlert(db: Db | Tx, me: MemberActor, alertId: string, exceptCaseId: string | null) {
  const rows = (
    await Promise.all(
      KINDS.map(async (kind) =>
        (
          await db
            .select({ caseId: kind.links.caseId, id: kind.items.id, type: kind.items.type, value: kind.items.value })
            .from(kind.alertLinks)
            .innerJoin(kind.items, eq(kind.alertLinks.itemId, kind.items.id))
            .innerJoin(kind.links, and(eq(kind.links.itemId, kind.items.id), isNull(kind.links.unlinkedAt)))
            .innerJoin(cases, eq(kind.links.caseId, cases.id))
            .where(
              and(
                eq(kind.alertLinks.alertId, alertId),
                visibleCases(me),
                exceptCaseId ? ne(cases.id, exceptCaseId) : undefined,
                notExists(
                  db
                    .select({ id: ignoredObservables.id })
                    .from(ignoredObservables)
                    .where(and(eq(kind.ignoredItem, kind.items.id), isNull(ignoredObservables.endedAt))),
                ),
              ),
            )
            .orderBy(asc(kind.alertLinks.seq))
        ).map((r) => ({ ...r, kind: kind.name }) as SharedItem & { caseId: string }),
      ),
    )
  ).flat();
  const byCase = new Map<string, SharedItem[]>();
  for (const { caseId, ...item } of rows) byCase.set(caseId, [...(byCase.get(caseId) ?? []), item]);
  return byCase;
}
