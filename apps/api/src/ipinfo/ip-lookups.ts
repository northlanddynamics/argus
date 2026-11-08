import { and, asc, eq } from "drizzle-orm";
import type { IntegrationHealth } from "../alerts/vocabulary";
import { ipLookups, integrations } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { openCredentials } from "../integrations/credentials";
import type { Membership } from "../members/membership";
import { normaliseObservable } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import { type IpDetails, IpinfoQuotaExceeded, IpinfoRefused, reservedRange } from "./ipinfo";

/**
 * Looking IP addresses up through the Organization's IPinfo Integration (ADR 0010), for any Member,
 * with the answers cached in `ip_lookups`: a cached answer younger than `IP_LOOKUP_FRESH_MS` is
 * served as it is, and an older one, or none, is fetched from IPinfo while the Member waits. Refresh
 * always fetches. A failed fetch keeps the last details and says why; it is not tried again for
 * `IP_LOOKUP_RETRY_MS` unless someone asks for a refresh, so a bad token doesn't cost a call on
 * every hover.
 *
 * Reserved addresses (private, loopback, link-local, documentation and the like) are never sent to
 * IPinfo: they mean nothing outside their own network, and they describe it. A paused Integration
 * serves what is cached and fetches nothing. What each fetch says about the token sets the
 * Integration's health, as Mimecast's checks do (`mimecast/health.ts`).
 */

/** How long a looked-up address's details are served without asking IPinfo again. */
export const IP_LOOKUP_FRESH_MS = 7 * 24 * 60 * 60_000;
/** How soon a failed lookup may be tried again without a refresh. */
export const IP_LOOKUP_RETRY_MS = 60_000;

/** The address asked about isn't an IPv4 or IPv6 address. */
export class InvalidIp extends Error {
  constructor() {
    super("That isn't an IPv4 or IPv6 address");
  }
}

/**
 * - `found`: IPinfo's details, as of `fetchedAt`.
 * - `reserved`: a reserved address, never looked up; `reserved` says which range, or that IPinfo called it a bogon.
 * - `unconfigured`: the Organization has no IPinfo Integration.
 * - `paused`: its IPinfo Integration is paused; `details` are what was cached, if anything.
 * - `failed`: the last lookup failed with `error`; `details` are what was cached before, if anything.
 */
export type IpLookupState = "found" | "reserved" | "unconfigured" | "paused" | "failed";

export type IpLookup = {
  /** The address in canonical form. */
  ip: string;
  state: IpLookupState;
  reserved: { range: string | null; label: string } | null;
  details: IpDetails | null;
  fetchedAt: string | null;
  error: string | null;
};

type Cached = typeof ipLookups.$inferSelect;

/** What `row` (cached for `ip`, if anything is) says, as a lookup in `state`. */
const answer = (ip: string, row: Cached | undefined, state: IpLookupState, error: string | null = null): IpLookup =>
  row?.bogon
    ? { ip, state: "reserved", reserved: { range: null, label: "Reserved" }, details: null, fetchedAt: null, error: null }
    : { ip, state, reserved: null, details: row?.details ?? null, fetchedAt: row?.fetchedAt?.toISOString() ?? null, error };

/** Records what a call to IPinfo said about an Integration's token, unless it was rotated or paused since. */
export async function recordIpinfoHealth(
  { db, clock }: Pick<Deps, "db" | "clock">,
  integration: { id: string; organizationId: string; credentialsRevision: number },
  health: IntegrationHealth,
  detail: string | null,
) {
  const now = clock.now();
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ health: integrations.health, healthDetail: integrations.healthDetail })
      .from(integrations)
      .where(and(eq(integrations.id, integration.id), eq(integrations.credentialsRevision, integration.credentialsRevision), eq(integrations.paused, false)))
      .for("update");
    if (!current) return;
    const changed = current.health !== health || current.healthDetail !== detail;
    await tx
      .update(integrations)
      .set({ healthCheckedAt: now, ...(changed && { health, healthDetail: detail, healthChangedAt: now }) })
      .where(eq(integrations.id, integration.id));
    if (changed) await publish(tx, { kind: "alerts", organizationId: integration.organizationId });
  });
}

export function ipLookupStore({ db, clock, credentials: sealer, ipinfo }: Pick<Deps, "db" | "clock" | "credentials" | "ipinfo">) {
  /** Lookups being fetched now, so a burst of hovers on one address costs one call. */
  const inFlight = new Map<string, Promise<IpLookup>>();

  const fetchAndStore = async (integration: typeof integrations.$inferSelect, ip: string, cached: Cached | undefined): Promise<IpLookup> => {
    const now = clock.now();
    const key = { organizationId: integration.organizationId, integrationId: integration.id, ip };
    try {
      const client = ipinfo(await openCredentials(sealer, "ipinfo", integration.credentials));
      const got = await client.lookup(ip);
      const values = { details: got.bogon ? null : got.details, bogon: got.bogon, fetchedAt: now, checkedAt: now, error: null };
      const [row] = await db
        .insert(ipLookups)
        .values({ id: secureId(), ...key, ...values })
        .onConflictDoUpdate({ target: [ipLookups.integrationId, ipLookups.ip], set: values })
        .returning();
      await recordIpinfoHealth({ db, clock }, integration, "connected", null);
      return answer(ip, row, "found");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const [row] = await db
        .insert(ipLookups)
        .values({ id: secureId(), ...key, checkedAt: now, error: message })
        .onConflictDoUpdate({ target: [ipLookups.integrationId, ipLookups.ip], set: { checkedAt: now, error: message } })
        .returning();
      const refused = e instanceof IpinfoRefused || e instanceof IpinfoQuotaExceeded;
      await recordIpinfoHealth({ db, clock }, integration, refused ? "error" : "disconnected", message);
      return answer(ip, row ?? cached, "failed", message);
    }
  };

  return {
    /**
     * What is known about `raw` (an IPv4 or IPv6 address, defanged or not), fetching it from IPinfo
     * when nothing fresh is cached, or always when `refresh`. Members only; any Member may look up
     * any address.
     */
    async lookup(me: Membership, raw: string, { refresh = false }: { refresh?: boolean } = {}): Promise<IpLookup> {
      const ip = normaliseObservable("ip", raw)?.value;
      if (!ip) throw new InvalidIp();
      const reserved = reservedRange(ip);
      if (reserved) return { ip, state: "reserved", reserved, details: null, fetchedAt: null, error: null };

      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, me.organizationId), eq(integrations.provider, "ipinfo")))
        .orderBy(asc(integrations.createdAt))
        .limit(1);
      if (!integration) return { ip, state: "unconfigured", reserved: null, details: null, fetchedAt: null, error: null };

      const [cached] = await db
        .select()
        .from(ipLookups)
        .where(and(eq(ipLookups.integrationId, integration.id), eq(ipLookups.ip, ip)))
        .limit(1);
      if (integration.paused) return answer(ip, cached, "paused");

      const now = clock.now().getTime();
      if (!refresh && cached) {
        const fresh = cached.fetchedAt && now - cached.fetchedAt.getTime() < IP_LOOKUP_FRESH_MS;
        const recentlyFailed = cached.error && now - cached.checkedAt.getTime() < IP_LOOKUP_RETRY_MS;
        if (recentlyFailed) return answer(ip, cached, "failed", cached.error);
        if (fresh && !cached.error) return answer(ip, cached, "found");
      }

      const flightKey = `${integration.id}:${ip}`;
      let flight = inFlight.get(flightKey);
      if (!flight) {
        flight = fetchAndStore(integration, ip, cached).finally(() => inFlight.delete(flightKey));
        inFlight.set(flightKey, flight);
      }
      return flight;
    },
  };
}

export type IpLookupStore = ReturnType<typeof ipLookupStore>;
