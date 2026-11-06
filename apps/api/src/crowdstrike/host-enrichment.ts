import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { assetFalconDevices, falconHostSnapshots, integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
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
 * Marks the snapshots of every device recorded on host `assetId` due. With `ifStale`, as when someone
 * opens the host's page, snapshots tried within `HOST_ENRICHMENT_MAX_AGE_MS` are left alone.
 */
export async function requestHostEnrichment(db: Db | Tx, assetId: string, now: Date, { ifStale = false } = {}) {
  const devices = await db
    .selectDistinct({ organizationId: assetFalconDevices.organizationId, integrationId: assetFalconDevices.integrationId, deviceId: assetFalconDevices.deviceId })
    .from(assetFalconDevices)
    .where(eq(assetFalconDevices.assetId, assetId));
  if (!devices.length) return;
  const since = new Date(now.getTime() - HOST_ENRICHMENT_MAX_AGE_MS);
  const s = falconHostSnapshots;
  await db
    .insert(s)
    .values(devices.map((d) => ({ id: secureId(), ...d, due: true })))
    .onConflictDoUpdate({
      target: [s.integrationId, s.deviceId],
      set: { due: true },
      setWhere: and(eq(s.due, false), ifStale ? or(isNull(s.checkedAt), lt(s.checkedAt, since)) : undefined),
    });
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

export const enrichmentKey = (d: { integrationId: string; deviceId: string }) => `${d.integrationId}\u0000${d.deviceId}`;

type Claimed = { id: string; organizationId: string; integrationId: string; deviceId: string };

/** What one fetch of an Integration's devices returned, or why it failed. */
type Fetched = { hosts: FalconHost[] } | { error: string; scopeMissing: boolean };

/** Stores what one fetch of `claimed`, all through one Integration, returned. */
async function storeFetched(tx: Tx, integrationId: string, claimed: readonly Claimed[], fetched: Fetched, now: Date) {
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
  }
  const unavailable = "error" in fetched && fetched.scopeMissing ? HOST_ENRICHMENT_UNAVAILABLE : null;
  if (!("error" in fetched) || unavailable) {
    await tx
      .update(integrations)
      .set({ hostEnrichmentError: unavailable })
      .where(and(eq(integrations.id, integrationId), sql`${integrations.hostEnrichmentError} IS DISTINCT FROM ${unavailable}`));
  }
}

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
      try {
        const client = await clientFor(integrationId);
        fetched = client
          ? { hosts: await client.hosts(claimed.map((c) => c.deviceId)) }
          : { error: "The Integration no longer exists", scopeMissing: false };
      } catch (e) {
        fetched = e instanceof FalconScopeMissing
          ? { error: HOST_ENRICHMENT_UNAVAILABLE, scopeMissing: true }
          : { error: e instanceof Error ? e.message : String(e), scopeMissing: false };
      }
      await db.transaction(async (tx) => {
        await storeFetched(tx, integrationId, claimed, fetched, clock.now());
        // Host pages and Integration health follow the Organization's Alerts and Integrations.
        await publish(tx, { kind: "alerts", organizationId: claimed[0]!.organizationId });
      });
    }
    return due.length;
  };

  let running: Promise<void> | null = null;
  return {
    /** Fetches every due snapshot, batch by batch. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
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
