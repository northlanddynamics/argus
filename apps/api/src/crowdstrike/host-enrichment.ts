import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { assetFalconDevices, assets, caseAssets, falconHostLookups, falconHostSnapshots, integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
import { containmentLiftedInFalcon } from "../response-actions/response-actions";
import { type FalconClient, type FalconConnector, type FalconHost, FalconScopeMissing } from "./falcon";
import { streamConnection } from "./stream-state";

/**
 * Host Enrichment (ADR 0009): what Falcon currently reports about each device recorded on a host,
 * read by `aid` through the Hosts API. Only the latest snapshot of each device is kept
 * (`falcon_host_snapshots`), shown as of when it was fetched.
 *
 * Opening a host's page asks for every snapshot of its devices older than
 * `HOST_ENRICHMENT_MAX_AGE_MS`; Refresh asks for all of them (`requestHostEnrichment`). Asking only
 * marks them due; the worker fetches due snapshots (`createHostEnricher`), so opening a page never
 * waits on Falcon, and a signal brings the page the result.
 *
 * A host with no device recorded for a CrowdStrike Integration (added by hand, or named only by
 * detections without an `aid`) is first looked up in Falcon by hostname (`falcon_host_lookups`),
 * marked due and done by the worker the same way. Every match is recorded on the host, several
 * making it ambiguous, and from then on its `aid` is used and not the hostname. No match shows as
 * not found in Falcon, and is looked up again the next time the host's Enrichment is fetched.
 *
 * A fetch showing a device released (neither contained nor being contained) ends every containment
 * Response Action Active for it, as lifted in Falcon (`containmentLiftedInFalcon`): for containment,
 * Active means Falcon last reported the host contained. A failed fetch, or a device Falcon doesn't
 * know, changes nothing.
 *
 * Enrichment is read-only, so it needs no Admin setting. When an Integration's API client lacks
 * Hosts: Read, the Integration's health says so (`host_enrichment_error`) and nothing else changes.
 */

/** A snapshot this recent is reused when a page is opened. */
export const HOST_ENRICHMENT_MAX_AGE_MS = 15 * 60_000;
/** The most snapshots fetched in one batch. */
export const HOST_ENRICHMENT_BATCH = 100;

/** What an Integration's health says while its API client lacks Hosts: Read. */
export const HOST_ENRICHMENT_UNAVAILABLE = "Host enrichment is unavailable: the API client lacks the Hosts: Read scope";

/**
 * Marks the snapshots of every device recorded on host `assetId` due, and the hostname lookup of
 * every CrowdStrike Integration that has recorded none on it. With `ifStale`, as when someone opens
 * the host's page, those tried within `HOST_ENRICHMENT_MAX_AGE_MS` are left alone. Resolves to
 * whether there was anything to ask Falcon for.
 */
export async function requestHostEnrichment(db: Db | Tx, assetId: string, now: Date, { ifStale = false } = {}) {
  const [host] = await db.select({ organizationId: assets.organizationId }).from(assets).where(and(eq(assets.id, assetId), eq(assets.type, "host")));
  if (!host) return false;
  const devices = await db
    .selectDistinct({ organizationId: assetFalconDevices.organizationId, integrationId: assetFalconDevices.integrationId, deviceId: assetFalconDevices.deviceId })
    .from(assetFalconDevices)
    .where(eq(assetFalconDevices.assetId, assetId));
  const withDevices = new Set(devices.map((d) => d.integrationId));
  const unresolved = (
    await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(eq(integrations.organizationId, host.organizationId), eq(integrations.provider, "crowdstrike"), isNull(integrations.deletedAt)))
  ).filter((i) => !withDevices.has(i.id));
  const since = new Date(now.getTime() - HOST_ENRICHMENT_MAX_AGE_MS);
  const s = falconHostSnapshots;
  if (devices.length) {
    await db
      .insert(s)
      .values(devices.map((d) => ({ id: secureId(), ...d, due: true })))
      .onConflictDoUpdate({
        target: [s.integrationId, s.deviceId],
        set: { due: true },
        setWhere: and(eq(s.due, false), ifStale ? or(isNull(s.checkedAt), lt(s.checkedAt, since)) : undefined),
      });
  }
  const l = falconHostLookups;
  if (unresolved.length) {
    await db
      .insert(l)
      .values(unresolved.map((i) => ({ id: secureId(), organizationId: host.organizationId, assetId, integrationId: i.id, due: true })))
      .onConflictDoUpdate({
        target: [l.assetId, l.integrationId],
        set: { due: true },
        setWhere: and(eq(l.due, false), ifStale ? or(isNull(l.checkedAt), lt(l.checkedAt, since)) : undefined),
      });
  }
  return devices.length > 0 || unresolved.length > 0;
}

/** One device's Enrichment, as a host's page shows it. */
export type HostEnrichmentView = {
  /** A fetch is wanted and the worker hasn't done it yet. */
  refreshing: boolean;
  /** When the snapshot shown was fetched; null before the first fetch succeeds. */
  fetchedAt: string | null;
  /** Falcon said, when last asked, that it doesn't know the device. */
  notFound: boolean;
  /** Why the last fetch failed, if it did. */
  error: string | null;
  host: FalconHost | null;
};

const nothingYet: HostEnrichmentView = { refreshing: false, fetchedAt: null, notFound: false, error: null, host: null };

/** The latest Enrichment of each of these devices, keyed by `enrichmentKey`. */
export async function hostEnrichmentOf(db: Db | Tx, devices: readonly { integrationId: string; deviceId: string }[]) {
  const views = new Map<string, HostEnrichmentView>();
  if (!devices.length) return views;
  const s = falconHostSnapshots;
  const rows = await db
    .select()
    .from(s)
    .where(
      and(
        inArray(s.integrationId, [...new Set(devices.map((d) => d.integrationId))]),
        inArray(s.deviceId, [...new Set(devices.map((d) => d.deviceId))]),
      ),
    );
  for (const r of rows) {
    views.set(enrichmentKey(r), {
      refreshing: r.due,
      fetchedAt: r.fetchedAt?.toISOString() ?? null,
      notFound: r.fetchedAt !== null && r.host === null,
      error: r.error,
      host: r.host,
    });
  }
  for (const d of devices) if (!views.has(enrichmentKey(d))) views.set(enrichmentKey(d), nothingYet);
  return views;
}

/** Looking a host up in Falcon by hostname, through an Integration that has recorded no device on it. */
export type HostLookupView = {
  /** A lookup is wanted and the worker hasn't done it yet. */
  refreshing: boolean;
  /** When Falcon was last asked; null before it first is. */
  checkedAt: string | null;
  /** Falcon said, when last asked, that it knows no device by the hostname. */
  notFound: boolean;
  /** Why the last lookup failed, if it did. */
  error: string | null;
};

/**
 * The hostname lookups of host `assetId`, by Integration, for the Integrations that have recorded no
 * device on it. A lookup that found devices has recorded them, so isn't among these.
 */
export async function hostLookupsOf(db: Db | Tx, assetId: string) {
  const l = falconHostLookups;
  const rows = await db
    .select({ integrationId: l.integrationId, due: l.due, checkedAt: l.checkedAt, error: l.error })
    .from(l)
    .where(
      and(
        eq(l.assetId, assetId),
        notExists(
          db
            .select({ id: assetFalconDevices.id })
            .from(assetFalconDevices)
            .where(and(eq(assetFalconDevices.assetId, l.assetId), eq(assetFalconDevices.integrationId, l.integrationId))),
        ),
      ),
    );
  return new Map(
    rows.map((r): [string, HostLookupView] => [
      r.integrationId,
      { refreshing: r.due, checkedAt: r.checkedAt?.toISOString() ?? null, notFound: r.checkedAt !== null && r.error === null, error: r.error },
    ]),
  );
}

export const enrichmentKey = (d: { integrationId: string; deviceId: string }) => `${d.integrationId}\u0000${d.deviceId}`;

type Claimed = { id: string; organizationId: string; integrationId: string; deviceId: string };

/** What one fetch of an Integration's devices returned, or why it failed. */
type Fetched = { hosts: FalconHost[] } | { error: string; scopeMissing: boolean };

/** Whether Falcon reports a host neither contained nor being contained. */
const released = (h: FalconHost) => h.containment !== null && h.containment !== "contained" && h.containment !== "containment_pending";

/** Stores what one fetch of `claimed`, all through one Integration and asked for at `askedAt`, returned. */
async function storeFetched(tx: Tx, integrationId: string, claimed: readonly Claimed[], fetched: Fetched, askedAt: Date, now: Date) {
  const s = falconHostSnapshots;
  if ("error" in fetched) {
    await tx
      .update(s)
      .set({ checkedAt: now, error: fetched.error })
      .where(inArray(s.id, claimed.map((c) => c.id)));
  } else {
    const byId = new Map(fetched.hosts.map((h) => [h.deviceId, h]));
    for (const c of claimed) {
      // A device Falcon doesn't know is recorded as not found.
      await tx
        .update(s)
        .set({ host: byId.get(c.deviceId) ?? null, fetchedAt: now, checkedAt: now, error: null })
        .where(eq(s.id, c.id));
    }
    const claimedIds = new Set(claimed.map((c) => c.deviceId));
    const releasedIds = fetched.hosts.filter((h) => claimedIds.has(h.deviceId) && released(h)).map((h) => h.deviceId);
    await containmentLiftedInFalcon(tx, { integrationId, deviceIds: releasedIds, askedAt, now });
  }
  await recordHealth(tx, integrationId, fetched);
}

/**
 * Stores what a fetch made outside the worker, as an internal IP lookup is (ADR 0018), said about
 * `hosts`, all through Integration `integrationId` and asked for at `askedAt`: each becomes its
 * device's snapshot, as the worker's fetch would make it, and one showing the device released ends
 * Argus's containment of it. Signals only when a snapshot changed, so the pages showing it follow,
 * and a lookup that learns nothing new wakes nobody. Call in a transaction.
 */
export async function storeHostsFetched(tx: Tx, organizationId: string, integrationId: string, hosts: readonly FalconHost[], askedAt: Date, now: Date) {
  const s = falconHostSnapshots;
  if (hosts.length) {
    const before = await tx
      .select({ deviceId: s.deviceId, host: s.host })
      .from(s)
      .where(and(eq(s.integrationId, integrationId), inArray(s.deviceId, hosts.map((h) => h.deviceId))));
    const was = new Map(before.map((b) => [b.deviceId, JSON.stringify(b.host)]));
    const changed = hosts.filter((h) => was.get(h.deviceId) !== JSON.stringify(h));
    await tx
      .insert(s)
      .values(hosts.map((host) => ({ id: secureId(), organizationId, integrationId, deviceId: host.deviceId, host, fetchedAt: now, checkedAt: now, error: null })))
      .onConflictDoUpdate({
        target: [s.integrationId, s.deviceId],
        set: { host: sql`excluded.host`, fetchedAt: now, checkedAt: now, error: null },
      });
    await containmentLiftedInFalcon(tx, { integrationId, deviceIds: hosts.filter(released).map((h) => h.deviceId), askedAt, now });
    if (changed.length) await announce(tx, organizationId, { devices: changed.map((h) => ({ id: "", organizationId, integrationId, deviceId: h.deviceId })) });
  }
  await recordHealth(tx, integrationId, { hosts });
}

/** Records in the Integration's health that a call outside the worker failed with `e`: only a missing Hosts: Read is noted. */
export async function recordHostCallFailure(tx: Tx, integrationId: string, e: unknown) {
  const failure = failureOf(e);
  await recordHealth(tx, integrationId, failure);
  return failure;
}

/**
 * Says in the Integration's health that host Enrichment is unavailable when Falcon refused for want
 * of Hosts: Read, and clears that once a call works. Other failures leave it as it was.
 */
async function recordHealth(tx: Tx, integrationId: string, outcome: object) {
  const failed = "error" in outcome;
  const unavailable = "scopeMissing" in outcome && outcome.scopeMissing ? HOST_ENRICHMENT_UNAVAILABLE : null;
  if (!failed || unavailable) {
    await tx
      .update(integrations)
      .set({ hostEnrichmentError: unavailable })
      .where(and(eq(integrations.id, integrationId), sql`${integrations.hostEnrichmentError} IS DISTINCT FROM ${unavailable}`));
  }
}

/**
 * Signals the Organization's Alerts and Integrations (host pages and Integration health follow
 * them), and every Case these hosts are linked to, whose Assets show their Enrichment. A Case whose
 * link to the host is Internal signals Members only, as Guests can't see the host there.
 */
async function announce(tx: Tx, organizationId: string, hosts: { assetIds?: readonly string[]; devices?: readonly Claimed[] }) {
  await publish(tx, { kind: "alerts", organizationId });
  const ids = new Set(hosts.assetIds ?? []);
  if (hosts.devices?.length) {
    const recorded = await tx
      .selectDistinct({ assetId: assetFalconDevices.assetId })
      .from(assetFalconDevices)
      .where(
        and(
          inArray(assetFalconDevices.integrationId, [...new Set(hosts.devices.map((d) => d.integrationId))]),
          inArray(assetFalconDevices.deviceId, hosts.devices.map((d) => d.deviceId)),
        ),
      );
    for (const r of recorded) ids.add(r.assetId);
  }
  if (!ids.size) return;
  const linked = await tx
    .select({ caseId: caseAssets.caseId, internal: caseAssets.internal })
    .from(caseAssets)
    .where(and(inArray(caseAssets.itemId, [...ids]), isNull(caseAssets.unlinkedAt)));
  const membersOnly = new Map<string, boolean>();
  for (const l of linked) membersOnly.set(l.caseId, (membersOnly.get(l.caseId) ?? true) && l.internal);
  for (const [caseId, internal] of membersOnly) await publish(tx, { kind: "case", organizationId, caseId, ...(internal ? { membersOnly: true } : {}) });
}

/** Why a call to Falcon failed, as a fetch or lookup records it. */
const failureOf = (e: unknown) =>
  e instanceof FalconScopeMissing
    ? { error: HOST_ENRICHMENT_UNAVAILABLE, scopeMissing: true }
    : { error: e instanceof Error ? e.message : String(e), scopeMissing: false };

/**
 * Fetches the snapshots marked due. Each batch is claimed in a short transaction with
 * `FOR UPDATE SKIP LOCKED`, which clears the mark, so however many workers run each fetch is made by
 * one and no row stays locked while Falcon answers. Asked for again meanwhile, a snapshot is due
 * again and fetched once more. Snapshots of paused Integrations, or deleted Organizations, wait.
 */
export function createHostEnricher({ db, clock, credentials }: Pick<Deps, "db" | "clock" | "credentials">, { connect }: { connect: FalconConnector }) {
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

  const s = falconHostSnapshots;
  const claim = () =>
    db.transaction(async (tx) => {
      const due: Claimed[] = await tx
        .select({ id: s.id, organizationId: s.organizationId, integrationId: s.integrationId, deviceId: s.deviceId })
        .from(s)
        .innerJoin(integrations, eq(s.integrationId, integrations.id))
        .innerJoin(organization, eq(s.organizationId, organization.id))
        .where(and(eq(s.due, true), eq(integrations.paused, false), isNull(organization.deletedAt)))
        .orderBy(asc(s.integrationId), asc(s.deviceId))
        .limit(HOST_ENRICHMENT_BATCH)
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
      let fetched: Fetched;
      const askedAt = clock.now();
      try {
        const client = await clientFor(integrationId);
        fetched = client
          ? { hosts: await client.hosts(claimed.map((c) => c.deviceId)) }
          : { error: "The Integration no longer exists", scopeMissing: false };
      } catch (e) {
        fetched = failureOf(e);
      }
      await db.transaction(async (tx) => {
        await storeFetched(tx, integrationId, claimed, fetched, askedAt, clock.now());
        await announce(tx, claimed[0]!.organizationId, { devices: claimed });
      });
    }
    return due.length;
  };

  const l = falconHostLookups;
  const claimLookups = () =>
    db.transaction(async (tx) => {
      const due = await tx
        .select({ id: l.id, organizationId: l.organizationId, assetId: l.assetId, integrationId: l.integrationId, hostname: assets.value })
        .from(l)
        .innerJoin(assets, eq(l.assetId, assets.id))
        .innerJoin(integrations, eq(l.integrationId, integrations.id))
        .innerJoin(organization, eq(l.organizationId, organization.id))
        .where(and(eq(l.due, true), eq(integrations.paused, false), isNull(organization.deletedAt)))
        .orderBy(asc(l.integrationId), asc(l.assetId))
        .limit(HOST_ENRICHMENT_BATCH)
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
   * Looks each claimed host up by hostname, unless a device has been recorded on it for that
   * Integration meanwhile. Every match is recorded on the host, and its snapshot marked due, so the
   * snapshots fetched next include it.
   */
  const lookUpBatch = async () => {
    const due = await claimLookups();
    for (const d of due) {
      const now = clock.now();
      const [recorded] = await db
        .select({ id: assetFalconDevices.id })
        .from(assetFalconDevices)
        .where(and(eq(assetFalconDevices.assetId, d.assetId), eq(assetFalconDevices.integrationId, d.integrationId)))
        .limit(1);
      if (recorded) {
        await db.update(l).set({ checkedAt: now, error: null }).where(eq(l.id, d.id));
        continue;
      }
      let outcome: { deviceIds: string[] } | { error: string; scopeMissing: boolean };
      try {
        const client = await clientFor(d.integrationId);
        outcome = client ? { deviceIds: await client.findHosts(d.hostname) } : { error: "The Integration no longer exists", scopeMissing: false };
      } catch (e) {
        outcome = failureOf(e);
      }
      await db.transaction(async (tx) => {
        if ("deviceIds" in outcome && outcome.deviceIds.length) {
          const found = outcome.deviceIds.map((deviceId) => ({ organizationId: d.organizationId, integrationId: d.integrationId, deviceId }));
          await tx
            .insert(assetFalconDevices)
            .values(found.map((f) => ({ id: secureId(), ...f, assetId: d.assetId, recordedAt: now })))
            .onConflictDoNothing();
          await tx
            .insert(s)
            .values(found.map((f) => ({ id: secureId(), ...f, due: true })))
            .onConflictDoUpdate({ target: [s.integrationId, s.deviceId], set: { due: true } });
        }
        await tx
          .update(l)
          .set({ checkedAt: now, error: "error" in outcome ? outcome.error : null })
          .where(eq(l.id, d.id));
        await recordHealth(tx, d.integrationId, outcome);
        await announce(tx, d.organizationId, { assetIds: [d.assetId] });
      });
    }
    return due.length;
  };

  let running: Promise<void> | null = null;
  return {
    /**
     * Does every due hostname lookup, then fetches every due snapshot (those of devices just found
     * included), batch by batch. A tick while one is running waits for that one.
     */
    tick() {
      running ??= (async () => {
        try {
          for (let batch = 0; batch < 20; batch++) {
            if ((await lookUpBatch()) < HOST_ENRICHMENT_BATCH) break;
          }
          for (let batch = 0; batch < 20; batch++) {
            if ((await fetchBatch()) < HOST_ENRICHMENT_BATCH) return;
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

export type HostEnricher = ReturnType<typeof createHostEnricher>;
