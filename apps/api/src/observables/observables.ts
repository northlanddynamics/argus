import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { casePolicy, visibleCases } from "../access/policy";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { CaseAuditAction } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { alertAssets, alertObservables, alerts, assets, caseAssets, caseObservables, cases, observables, user } from "../db/schema";
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
 */

/** The value isn't a valid one of its type. */
export class InvalidValue extends Error {}
export class NotLinked extends Error {}

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

type Kind<Type extends string> = {
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
            : { alert: me.role === "guest" ? null : { id: r.alertId, externalId: r.alertExternalId!, title: r.alertTitle! } },
      }));
  }

  return {
    list,

    /**
     * Links the Organization's `type` item with this value to the Case, first adding it to the
     * Organization if it's new. `linked` is false if it was already linked, and nothing changed.
     * Throws `InvalidValue` if the value isn't a valid `type`.
     */
    async link(me: Membership, number: number, type: Type, raw: string) {
      const normalised = kind.normalise(type, raw);
      if (!normalised) throw new InvalidValue(kind.invalid(type));
      const now = clock.now();
      const { itemId, linked } = await db.transaction(async (tx) => {
        const current = await lockCase(tx, me, number);
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
      });
      const view = (await list(me, number)).find((v) => v.id === itemId);
      if (!view) throw new NotLinked(`${kind.noun} not linked to this Case`);
      return { view, linked };
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
  items: observables,
  links: caseObservables,
  alertLinks: alertObservables,
  noun: "Observable",
  normalise: normaliseObservable,
  invalid: observableExpected,
  label: (type) => observableTypeLabel[type],
  linked: "observable.linked",
  unlinked: "observable.unlinked",
};

const assetKind: Kind<AssetType> = {
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
};

export const observableStore = (deps: { db: Db; clock: Clock }) => heldOnceStore(deps, observableKind);
export const assetStore = (deps: { db: Db; clock: Clock }) => heldOnceStore(deps, assetKind);

export type ObservableStore = ReturnType<typeof observableStore>;
export type AssetStore = ReturnType<typeof assetStore>;

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
