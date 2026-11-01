import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { casePolicy, visibleCases } from "../access/policy";
import { actorOf, CaseNotFound, lockCase } from "../cases/cases";
import { recordCaseAudit } from "../cases/case-audit-log";
import type { CaseAuditAction } from "../cases/vocabulary";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { assets, caseAssets, caseObservables, cases, observables, user } from "../db/schema";
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
  /** Other Cases it is linked to that the actor can see, newest first. */
  seenIn: SeenIn[];
};

type Kind<Type extends string> = {
  items: typeof observables;
  links: typeof caseObservables;
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
        })
        .from(links)
        .innerJoin(items, eq(links.itemId, items.id))
        .innerJoin(user, eq(links.linkedById, user.id))
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
          .select({ id: links.id })
          .from(links)
          .where(and(eq(links.caseId, current.id), eq(links.itemId, item.id), isNull(links.unlinkedAt)));
        if (already) return { itemId: item.id, linked: false };
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

export const observableStore = (deps: { db: Db; clock: Clock }) =>
  heldOnceStore<ObservableType>(deps, {
    items: observables,
    links: caseObservables,
    noun: "Observable",
    normalise: normaliseObservable,
    invalid: observableExpected,
    label: (type) => observableTypeLabel[type],
    linked: "observable.linked",
    unlinked: "observable.unlinked",
  });

export const assetStore = (deps: { db: Db; clock: Clock }) =>
  heldOnceStore<AssetType>(deps, {
    // Built by the same function as Observables' tables (`db/argus-schema.ts`), so the same shape.
    items: assets,
    links: caseAssets,
    noun: "Asset",
    normalise: normaliseAsset,
    invalid: (type) => `${assetTypeLabel[type]} needs an identifier`,
    label: (type) => assetTypeLabel[type],
    linked: "asset.linked",
    unlinked: "asset.unlinked",
  });

export type ObservableStore = ReturnType<typeof observableStore>;
export type AssetStore = ReturnType<typeof assetStore>;
