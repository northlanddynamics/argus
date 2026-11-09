import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { assetFalconIdentities, assets, falconIdentityLookups, falconIdentitySnapshots, integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
import { type AccountName, type FalconClient, type FalconConnector, type FalconIdentity, FalconScopeMissing } from "./falcon";
import { HOST_ENRICHMENT_MAX_AGE_MS } from "./host-enrichment";
import { streamConnection } from "./stream-state";

/**
 * Identity Enrichment (ADR 0009): what Falcon Identity Protection currently reports about each
 * identity recorded on an account Asset, read by entity ID. It works as host Enrichment does
 * (`host-enrichment.ts`): only the latest snapshot of each identity is kept
 * (`falcon_identity_snapshots`); opening the account's page asks for those older than 15 minutes,
 * Refresh for all of them (`requestIdentityEnrichment`); asking only marks them due, the worker
 * fetches them (`createIdentityEnricher`) and a signal brings the page the result.
 *
 * An account with no identity recorded for a CrowdStrike Integration is first looked up there by
 * name (`falcon_identity_lookups`, `accountName`): by UPN or email when it has an `@`, by domain and
 * SAM name for `DOMAIN\user`, by SAM name alone otherwise. Every match is recorded on the account,
 * several making it ambiguous (as a bare SAM name shared across domains can), and from then on the
 * entity ID is used and not the name. No match shows as not found in Falcon, and is looked up again
 * the next time the account's Enrichment is fetched.
 *
 * Enrichment is read-only, so it needs no Admin setting. When an Integration's API client lacks
 * Identity Protection Entities: Read, or its subscription lacks Identity Protection, the
 * Integration's health says so (`identity_enrichment_error`) and nothing else changes.
 */

/** A snapshot this recent is reused when a page is opened, as for hosts. */
export const IDENTITY_ENRICHMENT_MAX_AGE_MS = HOST_ENRICHMENT_MAX_AGE_MS;
/** The most snapshots fetched, or accounts looked up, in one batch. */
export const IDENTITY_ENRICHMENT_BATCH = 100;

/** What an Integration's health says while identities can't be read through it. */
export const IDENTITY_ENRICHMENT_UNAVAILABLE =
  "Identity enrichment is unavailable: the API client lacks the Identity Protection Entities: Read scope, or the subscription lacks Identity Protection";

/** How account `value` is looked up in Identity Protection; null when it is no name at all. */
export function accountName(value: string): AccountName | null {
  const v = value.trim();
  if (!v) return null;
  if (v.includes("@")) return { upn: v };
  const slash = v.indexOf("\\");
  if (slash > 0 && slash < v.length - 1) return { domain: v.slice(0, slash), samAccountName: v.slice(slash + 1) };
  const bare = v.replace(/^\\+|\\+$/g, "");
  return bare ? { samAccountName: bare } : null;
}

/**
 * Marks the snapshots of every identity recorded on account `assetId` due, and the lookup by name
 * through every CrowdStrike Integration that has recorded none on it. With `ifStale`, as when
 * someone opens the account's page, those tried within `IDENTITY_ENRICHMENT_MAX_AGE_MS` are left
 * alone. Resolves to whether there was anything to ask Falcon for.
 */
export async function requestIdentityEnrichment(db: Db | Tx, assetId: string, now: Date, { ifStale = false } = {}) {
  const [account] = await db
    .select({ organizationId: assets.organizationId, value: assets.value })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.type, "account")));
  if (!account) return false;
  const identities = await db
    .selectDistinct({ organizationId: assetFalconIdentities.organizationId, integrationId: assetFalconIdentities.integrationId, entityId: assetFalconIdentities.entityId })
    .from(assetFalconIdentities)
    .where(eq(assetFalconIdentities.assetId, assetId));
  const withIdentities = new Set(identities.map((d) => d.integrationId));
  const unresolved = accountName(account.value)
    ? (
        await db
          .select({ id: integrations.id })
          .from(integrations)
          .where(and(eq(integrations.organizationId, account.organizationId), eq(integrations.provider, "crowdstrike"), isNull(integrations.deletedAt)))
      ).filter((i) => !withIdentities.has(i.id))
    : [];
  const since = new Date(now.getTime() - IDENTITY_ENRICHMENT_MAX_AGE_MS);
  const s = falconIdentitySnapshots;
  if (identities.length) {
    await db
      .insert(s)
      .values(identities.map((d) => ({ id: secureId(), ...d, due: true })))
      .onConflictDoUpdate({
        target: [s.integrationId, s.entityId],
        set: { due: true },
        setWhere: and(eq(s.due, false), ifStale ? or(isNull(s.checkedAt), lt(s.checkedAt, since)) : undefined),
      });
  }
  const l = falconIdentityLookups;
  if (unresolved.length) {
    await db
      .insert(l)
      .values(unresolved.map((i) => ({ id: secureId(), organizationId: account.organizationId, assetId, integrationId: i.id, due: true })))
      .onConflictDoUpdate({
        target: [l.assetId, l.integrationId],
        set: { due: true },
        setWhere: and(eq(l.due, false), ifStale ? or(isNull(l.checkedAt), lt(l.checkedAt, since)) : undefined),
      });
  }
  return identities.length > 0 || unresolved.length > 0;
}

/** One identity's Enrichment, as an account's page shows it. */
export type IdentityEnrichmentView = {
  /** A fetch is wanted and the worker hasn't done it yet. */
  refreshing: boolean;
  /** When the snapshot shown was fetched; null before the first fetch succeeds. */
  fetchedAt: string | null;
  /** Falcon said, when last asked, that it doesn't know the identity. */
  notFound: boolean;
  /** Why the last fetch failed, if it did. */
  error: string | null;
  identity: FalconIdentity | null;
};

/** Looking an account up in Identity Protection by name, through an Integration that has recorded no identity on it. */
export type IdentityLookupView = {
  /** A lookup is wanted and the worker hasn't done it yet. */
  refreshing: boolean;
  /** When Falcon was last asked; null before it first is. */
  checkedAt: string | null;
  /** Falcon said, when last asked, that it knows no identity by the name. */
  notFound: boolean;
  /** Why the last lookup failed, if it did. */
  error: string | null;
};

/**
 * The Identity Protection identities recorded on an account for one Integration; `ambiguous` when
 * there are several. Each has its latest Enrichment. `enrichmentUnavailable` says why the
 * Integration can't enrich identities. An Integration that has recorded no identity on the account
 * has none here, and `lookup` says how looking the account up by name went; it is null once an
 * identity is recorded.
 */
export type FalconIdentities = {
  integration: { id: string; name: string; enrichmentUnavailable: string | null };
  ambiguous: boolean;
  identities: { entityId: string; recordedAt: string; enrichment: IdentityEnrichmentView }[];
  lookup: IdentityLookupView | null;
};

const nothingYet: IdentityEnrichmentView = { refreshing: false, fetchedAt: null, notFound: false, error: null, identity: null };

const snapshotKey = (d: { integrationId: string; entityId: string }) => `${d.integrationId}\u0000${d.entityId}`;

/**
 * The identities recorded on account `assetId`, by Integration in the order each was first
 * recorded, with their Enrichment. After them come the Integrations that have recorded no identity
 * on the account but have looked it up by name, by name.
 */
export async function falconIdentitiesOf(db: Db | Tx, assetId: string): Promise<FalconIdentities[]> {
  const a = assetFalconIdentities;
  const rows = await db
    .select({
      integrationId: integrations.id,
      integrationName: integrations.name,
      enrichmentUnavailable: integrations.identityEnrichmentError,
      entityId: a.entityId,
      recordedAt: a.recordedAt,
    })
    .from(a)
    .innerJoin(integrations, eq(a.integrationId, integrations.id))
    .where(eq(a.assetId, assetId))
    .orderBy(asc(a.recordedAt), asc(a.seq));
  const views = new Map<string, IdentityEnrichmentView>();
  if (rows.length) {
    const s = falconIdentitySnapshots;
    const snapshots = await db
      .select()
      .from(s)
      .where(and(inArray(s.integrationId, [...new Set(rows.map((r) => r.integrationId))]), inArray(s.entityId, [...new Set(rows.map((r) => r.entityId))])));
    for (const r of snapshots) {
      views.set(snapshotKey(r), {
        refreshing: r.due,
        fetchedAt: r.fetchedAt?.toISOString() ?? null,
        notFound: r.fetchedAt !== null && r.identity === null,
        error: r.error,
        identity: r.identity,
      });
    }
  }
  const byIntegration = new Map<string, FalconIdentities>();
  for (const r of rows) {
    const entry = byIntegration.get(r.integrationId) ?? {
      integration: { id: r.integrationId, name: r.integrationName, enrichmentUnavailable: r.enrichmentUnavailable },
      ambiguous: false,
      identities: [],
      lookup: null,
    };
    entry.identities.push({ entityId: r.entityId, recordedAt: r.recordedAt.toISOString(), enrichment: views.get(snapshotKey(r)) ?? nothingYet });
    entry.ambiguous = entry.identities.length > 1;
    byIntegration.set(r.integrationId, entry);
  }
  const l = falconIdentityLookups;
  const lookups = await db
    .select({
      integrationId: l.integrationId,
      name: integrations.name,
      enrichmentUnavailable: integrations.identityEnrichmentError,
      due: l.due,
      checkedAt: l.checkedAt,
      error: l.error,
    })
    .from(l)
    .innerJoin(integrations, eq(l.integrationId, integrations.id))
    .where(
      and(
        eq(l.assetId, assetId),
        notExists(db.select({ id: a.id }).from(a).where(and(eq(a.assetId, l.assetId), eq(a.integrationId, l.integrationId)))),
      ),
    )
    .orderBy(asc(integrations.name));
  for (const r of lookups) {
    if (byIntegration.has(r.integrationId)) continue;
    byIntegration.set(r.integrationId, {
      integration: { id: r.integrationId, name: r.name, enrichmentUnavailable: r.enrichmentUnavailable },
      ambiguous: false,
      identities: [],
      lookup: { refreshing: r.due, checkedAt: r.checkedAt?.toISOString() ?? null, notFound: r.checkedAt !== null && r.error === null, error: r.error },
    });
  }
  return [...byIntegration.values()];
}

type Claimed = { id: string; organizationId: string; integrationId: string; entityId: string };

/** What one call to Identity Protection returned, or why it failed. */
type Outcome<T> = T | { error: string; scopeMissing: boolean };

/** Why a call to Identity Protection failed, as a fetch or lookup records it. */
const failureOf = (e: unknown) =>
  e instanceof FalconScopeMissing
    ? { error: IDENTITY_ENRICHMENT_UNAVAILABLE, scopeMissing: true }
    : { error: e instanceof Error ? e.message : String(e), scopeMissing: false };

/**
 * Says in the Integration's health that identity Enrichment is unavailable when Falcon refused for
 * want of the scope or subscription, and clears that once a call works. Other failures leave it.
 */
async function recordHealth(tx: Tx, integrationId: string, outcome: object) {
  const failed = "error" in outcome;
  const unavailable = "scopeMissing" in outcome && outcome.scopeMissing ? IDENTITY_ENRICHMENT_UNAVAILABLE : null;
  if (!failed || unavailable) {
    await tx
      .update(integrations)
      .set({ identityEnrichmentError: unavailable })
      .where(and(eq(integrations.id, integrationId), sql`${integrations.identityEnrichmentError} IS DISTINCT FROM ${unavailable}`));
  }
}

/**
 * Fetches due snapshots and does due lookups, as the host enricher does: each batch is claimed in a
 * short transaction with `FOR UPDATE SKIP LOCKED`, which clears the mark, so each call is made by one
 * worker and no row stays locked while Falcon answers. Paused Integrations, and deleted
 * Organizations, wait. Every result signals the Organization's Alerts, which account pages and
 * Integration health follow.
 */
export function createIdentityEnricher({ db, clock, credentials }: Pick<Deps, "db" | "clock" | "credentials">, { connect }: { connect: FalconConnector }) {
  /** One client per Integration, until its credentials are rotated. */
  const clients = new Map<string, { revision: number; client: FalconClient }>();
  const clientFor = async (integrationId: string) => {
    const found = await streamConnection(db, credentials, integrationId);
    if (!found) return null;
    const cached = clients.get(integrationId);
    if (cached?.revision === found.credentialsRevision) return cached.client;
    const client = connect(found.connection);
    clients.set(integrationId, { revision: found.credentialsRevision, client });
    return client;
  };
  const gone = { error: "The Integration no longer exists", scopeMissing: false };

  const s = falconIdentitySnapshots;
  const claim = () =>
    db.transaction(async (tx) => {
      const due: Claimed[] = await tx
        .select({ id: s.id, organizationId: s.organizationId, integrationId: s.integrationId, entityId: s.entityId })
        .from(s)
        .innerJoin(integrations, eq(s.integrationId, integrations.id))
        .innerJoin(organization, eq(s.organizationId, organization.id))
        .where(and(eq(s.due, true), eq(integrations.paused, false), isNull(organization.deletedAt)))
        .orderBy(asc(s.integrationId), asc(s.entityId))
        .limit(IDENTITY_ENRICHMENT_BATCH)
        .for("update", { of: s, skipLocked: true });
      if (due.length) {
        await tx
          .update(s)
          .set({ due: false })
          .where(inArray(s.id, due.map((d) => d.id)));
      }
      return due;
    });

  const fetchBatch = async () => {
    const due = await claim();
    const byIntegration = new Map<string, Claimed[]>();
    for (const d of due) byIntegration.set(d.integrationId, [...(byIntegration.get(d.integrationId) ?? []), d]);
    for (const [integrationId, claimed] of byIntegration) {
      let fetched: Outcome<{ identities: FalconIdentity[] }>;
      try {
        const client = await clientFor(integrationId);
        fetched = client ? { identities: await client.identities(claimed.map((c) => c.entityId)) } : gone;
      } catch (e) {
        fetched = failureOf(e);
      }
      const now = clock.now();
      await db.transaction(async (tx) => {
        if ("error" in fetched) {
          await tx
            .update(s)
            .set({ checkedAt: now, error: fetched.error })
            .where(inArray(s.id, claimed.map((c) => c.id)));
        } else {
          const byId = new Map(fetched.identities.map((i) => [i.entityId, i]));
          for (const c of claimed) {
            // An identity Falcon doesn't know is recorded as not found.
            await tx
              .update(s)
              .set({ identity: byId.get(c.entityId) ?? null, fetchedAt: now, checkedAt: now, error: null })
              .where(eq(s.id, c.id));
          }
        }
        await recordHealth(tx, integrationId, fetched);
        await publish(tx, { kind: "alerts", organizationId: claimed[0]!.organizationId });
      });
    }
    return due.length;
  };

  const l = falconIdentityLookups;
  const claimLookups = () =>
    db.transaction(async (tx) => {
      const due = await tx
        .select({ id: l.id, organizationId: l.organizationId, assetId: l.assetId, integrationId: l.integrationId, value: assets.value })
        .from(l)
        .innerJoin(assets, eq(l.assetId, assets.id))
        .innerJoin(integrations, eq(l.integrationId, integrations.id))
        .innerJoin(organization, eq(l.organizationId, organization.id))
        .where(and(eq(l.due, true), eq(integrations.paused, false), isNull(organization.deletedAt)))
        .orderBy(asc(l.integrationId), asc(l.assetId))
        .limit(IDENTITY_ENRICHMENT_BATCH)
        .for("update", { of: l, skipLocked: true });
      if (due.length) {
        await tx
          .update(l)
          .set({ due: false })
          .where(inArray(l.id, due.map((d) => d.id)));
      }
      return due;
    });

  /**
   * Looks each claimed account up by name, unless an identity has been recorded on it for that
   * Integration meanwhile. Every match is recorded on the account, and its snapshot marked due, so
   * the snapshots fetched next include it.
   */
  const lookUpBatch = async () => {
    const due = await claimLookups();
    for (const d of due) {
      const now = clock.now();
      const [recorded] = await db
        .select({ id: assetFalconIdentities.id })
        .from(assetFalconIdentities)
        .where(and(eq(assetFalconIdentities.assetId, d.assetId), eq(assetFalconIdentities.integrationId, d.integrationId)))
        .limit(1);
      const name = accountName(d.value);
      if (recorded || !name) {
        await db.update(l).set({ checkedAt: now, error: null }).where(eq(l.id, d.id));
        continue;
      }
      let outcome: Outcome<{ entityIds: string[] }>;
      try {
        const client = await clientFor(d.integrationId);
        outcome = client ? { entityIds: await client.findIdentities(name) } : gone;
      } catch (e) {
        outcome = failureOf(e);
      }
      await db.transaction(async (tx) => {
        if ("entityIds" in outcome && outcome.entityIds.length) {
          const found = outcome.entityIds.map((entityId) => ({ organizationId: d.organizationId, integrationId: d.integrationId, entityId }));
          await tx
            .insert(assetFalconIdentities)
            .values(found.map((f) => ({ id: secureId(), ...f, assetId: d.assetId, recordedAt: now })))
            .onConflictDoNothing();
          await tx
            .insert(s)
            .values(found.map((f) => ({ id: secureId(), ...f, due: true })))
            .onConflictDoUpdate({ target: [s.integrationId, s.entityId], set: { due: true } });
        }
        await tx
          .update(l)
          .set({ checkedAt: now, error: "error" in outcome ? outcome.error : null })
          .where(eq(l.id, d.id));
        await recordHealth(tx, d.integrationId, outcome);
        await publish(tx, { kind: "alerts", organizationId: d.organizationId });
      });
    }
    return due.length;
  };

  let running: Promise<void> | null = null;
  return {
    /**
     * Does every due lookup by name, then fetches every due snapshot (those of identities just found
     * included), batch by batch. A tick while one is running waits for that one.
     */
    tick() {
      running ??= (async () => {
        try {
          for (let batch = 0; batch < 20; batch++) {
            if ((await lookUpBatch()) < IDENTITY_ENRICHMENT_BATCH) break;
          }
          for (let batch = 0; batch < 20; batch++) {
            if ((await fetchBatch()) < IDENTITY_ENRICHMENT_BATCH) return;
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

export type IdentityEnricher = ReturnType<typeof createIdentityEnricher>;
