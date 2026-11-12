import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { falconDeviceUrl } from "../alerts/vocabulary";
import { assetFalconDevices, assets, falconHostSnapshots, falconIpLookups, integrations } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import type { FalconClient, FalconHost } from "./falcon";
import { HOST_ENRICHMENT_MAX_AGE_MS, recordHostCallFailure, storeHostsFetched } from "./host-enrichment";
import { streamConnection } from "./stream-state";

/**
 * Internal IP lookups in Falcon (ADR 0018): which devices last reported a private, shared or
 * unique-local address as their local IP, through each of the Organization's CrowdStrike
 * Integrations, fetched while the Member waits as IPinfo lookups are (ADR 0010).
 *
 * Each Integration's answer is cached in `falcon_ip_lookups` and served for
 * `HOST_ENRICHMENT_MAX_AGE_MS`, since addresses are leased again; Refresh always asks. A failed
 * lookup keeps the last answer and says why, and is not tried again for `IP_HOST_LOOKUP_RETRY_MS`
 * unless someone refreshes. The devices' details are stored as their host Enrichment snapshots
 * (`storeHostsFetched`), so an IP's lookup and a host's page show the same thing. A paused
 * Integration serves what is cached and asks nothing. Only a missing Hosts: Read is recorded in an
 * Integration's health: the stream worker owns the rest of it.
 */

/** How soon a failed lookup may be tried again without a refresh. */
export const IP_HOST_LOOKUP_RETRY_MS = 60_000;

/** One device that last reported the address, as its latest snapshot shows it. */
export type IpHost = {
  deviceId: string;
  /** The device in the Falcon console. */
  consoleUrl: string;
  /** Its snapshot; null when Falcon no longer knows the device. */
  host: FalconHost | null;
  /** The host Asset its `aid` is recorded on, if Argus holds one. */
  asset: { id: string; value: string } | null;
};

/**
 * What one CrowdStrike Integration says about the address.
 * - `found`: `hosts` last reported it (none when Falcon knows no device by it), as of `fetchedAt`.
 * - `paused`: the Integration is paused; `hosts` are what was cached, if anything.
 * - `failed`: the last lookup failed with `error`; `hosts` are what was cached before, if anything.
 */
export type IpHostLookup = {
  integration: { id: string; name: string };
  state: "found" | "paused" | "failed";
  /** Seen most recently first. */
  hosts: IpHost[];
  /** How many devices Falcon matched in all; more than `hosts` when it matched over 50. */
  total: number;
  fetchedAt: string | null;
  error: string | null;
};

type Integration = typeof integrations.$inferSelect;
type Cached = typeof falconIpLookups.$inferSelect;

export function ipHostLookupStore({ db, clock, credentials, falcon }: Pick<Deps, "db" | "clock" | "credentials" | "falcon">) {
  /** One client per Integration, until its credentials are rotated, so its OAuth token is reused across lookups. */
  const clients = new Map<string, { revision: number; client: FalconClient }>();
  const clientFor = async (integrationId: string) => {
    const found = await streamConnection(db, credentials, integrationId);
    if (!found) return null;
    const cached = clients.get(integrationId);
    if (cached?.revision === found.credentialsRevision) return cached.client;
    const client = falcon(found.connection);
    clients.set(integrationId, { revision: found.credentialsRevision, client });
    return client;
  };
  /** Lookups being fetched now, so a burst of hovers on one address costs one call per Integration. */
  const inFlight = new Map<string, Promise<IpHostLookup>>();

  /** `row`'s devices as the Member sees them, newest first. */
  const view = async (integration: Integration, row: Cached | undefined, state: IpHostLookup["state"], error: string | null = null): Promise<IpHostLookup> => {
    const deviceIds = row?.deviceIds ?? [];
    const snapshots = deviceIds.length
      ? await db
          .select({ deviceId: falconHostSnapshots.deviceId, host: falconHostSnapshots.host })
          .from(falconHostSnapshots)
          .where(and(eq(falconHostSnapshots.integrationId, integration.id), inArray(falconHostSnapshots.deviceId, deviceIds)))
      : [];
    const recorded = deviceIds.length
      ? await db
          .select({ deviceId: assetFalconDevices.deviceId, id: assets.id, value: assets.value })
          .from(assetFalconDevices)
          .innerJoin(assets, eq(assetFalconDevices.assetId, assets.id))
          .where(and(eq(assetFalconDevices.integrationId, integration.id), inArray(assetFalconDevices.deviceId, deviceIds)))
          .orderBy(asc(assetFalconDevices.recordedAt))
      : [];
    const hostOf = new Map(snapshots.map((s) => [s.deviceId, s.host]));
    const assetOf = new Map<string, { id: string; value: string }>();
    for (const r of recorded) if (!assetOf.has(r.deviceId)) assetOf.set(r.deviceId, { id: r.id, value: r.value });
    const hosts = deviceIds
      .map((deviceId) => ({
        deviceId,
        consoleUrl: falconDeviceUrl(integration.cloud!, deviceId),
        host: hostOf.get(deviceId) ?? null,
        asset: assetOf.get(deviceId) ?? null,
      }))
      // Falcon sorts by last seen; the snapshots may have been fetched since.
      .toSorted((a, b) => (b.host?.lastSeen ?? "").localeCompare(a.host?.lastSeen ?? ""));
    return {
      integration: { id: integration.id, name: integration.name },
      state,
      hosts,
      total: row?.total ?? 0,
      fetchedAt: row?.fetchedAt?.toISOString() ?? null,
      error,
    };
  };

  const fetchAndStore = async (integration: Integration, ip: string, cached: Cached | undefined): Promise<IpHostLookup> => {
    const askedAt = clock.now();
    const key = { organizationId: integration.organizationId, integrationId: integration.id, ip };
    try {
      const client = await clientFor(integration.id);
      if (!client) throw new Error("The Integration no longer exists");
      const found = await client.findHostsByLocalIp(ip);
      const hosts = found.deviceIds.length ? await client.hosts(found.deviceIds) : [];
      const now = clock.now();
      const row = await db.transaction(async (tx) => {
        const values = { deviceIds: found.deviceIds, total: found.total, fetchedAt: now, checkedAt: now, error: null };
        const [stored] = await tx
          .insert(falconIpLookups)
          .values({ id: secureId(), ...key, ...values })
          .onConflictDoUpdate({ target: [falconIpLookups.integrationId, falconIpLookups.ip], set: values })
          .returning();
        await storeHostsFetched(tx, integration.organizationId, integration.id, hosts, askedAt, now);
        return stored;
      });
      return view(integration, row, "found");
    } catch (e) {
      const now = clock.now();
      const row = await db.transaction(async (tx) => {
        const { error } = await recordHostCallFailure(tx, integration.id, e);
        const [stored] = await tx
          .insert(falconIpLookups)
          .values({ id: secureId(), ...key, checkedAt: now, error })
          .onConflictDoUpdate({ target: [falconIpLookups.integrationId, falconIpLookups.ip], set: { checkedAt: now, error } })
          .returning();
        return stored;
      });
      return view(integration, row ?? cached, "failed", row?.error ?? null);
    }
  };

  const lookupThrough = async (integration: Integration, ip: string, refresh: boolean): Promise<IpHostLookup> => {
    const [cached] = await db
      .select()
      .from(falconIpLookups)
      .where(and(eq(falconIpLookups.integrationId, integration.id), eq(falconIpLookups.ip, ip)))
      .limit(1);
    if (integration.paused) return view(integration, cached, "paused");
    const now = clock.now().getTime();
    if (!refresh && cached) {
      const fresh = cached.fetchedAt && now - cached.fetchedAt.getTime() < HOST_ENRICHMENT_MAX_AGE_MS;
      const recentlyFailed = cached.error && now - cached.checkedAt.getTime() < IP_HOST_LOOKUP_RETRY_MS;
      if (recentlyFailed) return view(integration, cached, "failed", cached.error);
      if (fresh && !cached.error) return view(integration, cached, "found");
    }
    const flightKey = `${integration.id}:${ip}`;
    let flight = inFlight.get(flightKey);
    if (!flight) {
      flight = fetchAndStore(integration, ip, cached).finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, flight);
    }
    return flight;
  };

  return {
    /**
     * What each of the Organization's CrowdStrike Integrations says last reported `ip`, an internal
     * address in canonical form; none when it has no CrowdStrike Integration. Each is asked in
     * parallel, when it has nothing fresh cached or always when `refresh`. Members only.
     */
    async lookup(me: Membership, ip: string, { refresh = false }: { refresh?: boolean } = {}): Promise<IpHostLookup[]> {
      const found = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, me.organizationId), eq(integrations.provider, "crowdstrike"), isNull(integrations.deletedAt)))
        // As Settings lists them.
        .orderBy(asc(integrations.createdAt), asc(integrations.id));
      return Promise.all(found.filter((i) => i.cloud).map((i) => lookupThrough(i, ip, refresh)));
    },
  };
}

export type IpHostLookupStore = ReturnType<typeof ipHostLookupStore>;
