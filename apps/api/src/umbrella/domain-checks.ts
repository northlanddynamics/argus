import { and, asc, eq, isNull } from "drizzle-orm";
import { integrations } from "../db/schema";
import type { Deps } from "../deps";
import { openCredentials } from "../integrations/credentials";
import { recordIpinfoHealth as recordHealth } from "../ipinfo/ip-lookups";
import type { Membership } from "../members/membership";
import { normaliseObservable } from "../observables/vocabulary";
import { covers, type Destination, type DestinationList, UmbrellaRefused } from "./umbrella";

/**
 * Checking a domain against the Organization's Cisco Umbrella destination lists (ADR 0014), for any
 * Member, while they wait: through every Umbrella Integration that isn't deleted, which of its
 * destination lists hold the domain, or a domain above it (Umbrella applies a domain destination to
 * every name under it).
 *
 * Umbrella can't be asked which lists hold a domain, so Argus reads every list of the Integration and
 * matches in Argus: the domain itself is never sent to Umbrella. What was read is kept in this
 * process for `UMBRELLA_LISTS_FRESH_MS`, so a burst of checks costs one read of the lists; a refresh
 * always reads them again, and concurrent reads for one Integration share one. A failed read keeps
 * what was read before and says why, and isn't tried again for `UMBRELLA_RETRY_MS` unless someone
 * refreshes. What each read says of the credentials sets the Integration's health, as IPinfo lookups
 * do. A paused Integration serves what was read before, and reads nothing.
 */

/** How long what was read of an Integration's lists is used without reading them again. */
export const UMBRELLA_LISTS_FRESH_MS = 5 * 60_000;
/** How soon a failed read may be tried again without a refresh. */
export const UMBRELLA_RETRY_MS = 60_000;

/** The value asked about isn't a domain or an email address. */
export class InvalidDomain extends Error {
  constructor() {
    super("That isn't a domain or an email address");
  }
}

/** A destination list holding the domain, or a domain above it. */
export type DestinationListMatch = {
  list: DestinationList;
  /** The destination as the list holds it. */
  destination: string;
  /** `exact`: the domain itself; `parent`: a domain above it, which covers it. */
  matchedBy: "exact" | "parent";
  comment: string | null;
  addedAt: string | null;
};

/**
 * Through one Umbrella Integration:
 * - `checked`: its lists were read, as of `checkedAt`.
 * - `paused`: it is paused; `matches` are from what was read before, if anything.
 * - `failed`: reading its lists failed with `error`; `matches` are from what was read before, if anything.
 */
export type UmbrellaDomainCheck = {
  integration: { id: string; name: string };
  state: "checked" | "paused" | "failed";
  /** When its lists were read; null if they never have been. */
  checkedAt: string | null;
  error: string | null;
  /** How many destination lists were read. */
  listCount: number;
  matches: DestinationListMatch[];
};

/** A domain checked against every Umbrella Integration of the Organization; none means it has none. */
export type DomainCheck = { domain: string; integrations: UmbrellaDomainCheck[] };

type Snapshot = { revision: number; readAt: Date; lists: { list: DestinationList; destinations: Destination[] }[] };
type Failure = { revision: number; at: Date; error: string };

/** Every list holding `domain` or a domain above it, exact ones first. */
function matchesIn(snapshot: Snapshot | undefined, domain: string): DestinationListMatch[] {
  const found: DestinationListMatch[] = [];
  for (const { list, destinations } of snapshot?.lists ?? []) {
    for (const d of destinations) {
      const matchedBy = covers(d, domain);
      if (matchedBy) found.push({ list, destination: d.destination, matchedBy, comment: d.comment, addedAt: d.createdAt });
    }
  }
  return found.toSorted((a, b) => (a.matchedBy === b.matchedBy ? a.list.name.localeCompare(b.list.name) : a.matchedBy === "exact" ? -1 : 1));
}

export function umbrellaDomainCheckStore({ db, clock, credentials: sealer, umbrella }: Pick<Deps, "db" | "clock" | "credentials" | "umbrella">) {
  const snapshots = new Map<string, Snapshot>();
  const failures = new Map<string, Failure>();
  const inFlight = new Map<string, Promise<void>>();

  /** Reads every list of `integration`, keeping what was read, or why it failed. */
  const read = async (integration: typeof integrations.$inferSelect) => {
    const now = clock.now();
    try {
      const client = umbrella(await openCredentials(sealer, "umbrella", integration.credentials));
      const lists = await client.destinationLists();
      const held = [];
      for (const list of lists) held.push({ list, destinations: await client.destinations(list.id) });
      snapshots.set(integration.id, { revision: integration.credentialsRevision, readAt: now, lists: held });
      failures.delete(integration.id);
      await recordHealth({ db, clock }, integration, "connected", null);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failures.set(integration.id, { revision: integration.credentialsRevision, at: now, error });
      await recordHealth({ db, clock }, integration, e instanceof UmbrellaRefused ? "error" : "disconnected", error);
    }
  };

  const check = async (integration: typeof integrations.$inferSelect, domain: string, refresh: boolean): Promise<UmbrellaDomainCheck> => {
    // What was read with credentials since rotated says nothing.
    const kept = (m: Map<string, { revision: number }>) => {
      const found = m.get(integration.id);
      return found?.revision === integration.credentialsRevision ? found : undefined;
    };
    if (!integration.paused) {
      const now = clock.now().getTime();
      const snapshot = kept(snapshots) as Snapshot | undefined;
      const failure = kept(failures) as Failure | undefined;
      const fresh = snapshot && now - snapshot.readAt.getTime() < UMBRELLA_LISTS_FRESH_MS;
      const recentlyFailed = failure && now - failure.at.getTime() < UMBRELLA_RETRY_MS;
      if (refresh || (!fresh && !recentlyFailed)) {
        let flight = inFlight.get(integration.id);
        if (!flight) {
          flight = read(integration).finally(() => inFlight.delete(integration.id));
          inFlight.set(integration.id, flight);
        }
        await flight;
      }
    }
    const snapshot = kept(snapshots) as Snapshot | undefined;
    const failure = kept(failures) as Failure | undefined;
    return {
      integration: { id: integration.id, name: integration.name },
      state: integration.paused ? "paused" : failure ? "failed" : "checked",
      checkedAt: snapshot?.readAt.toISOString() ?? null,
      error: integration.paused ? null : (failure?.error ?? null),
      listCount: snapshot?.lists.length ?? 0,
      matches: matchesIn(snapshot, domain),
    };
  };

  return {
    /**
     * Which destination lists of each of the Organization's Cisco Umbrella Integrations hold `raw` (a
     * domain, defanged or not, or an email address, checked by its domain) or a domain above it.
     * Reads the lists when what was read is stale, or always when `refresh`. Members only.
     */
    async check(me: Membership, raw: string, { refresh = false }: { refresh?: boolean } = {}): Promise<DomainCheck> {
      const domain = normaliseObservable("domain", raw)?.key ?? normaliseObservable("email", raw)?.key.split("@").pop();
      if (!domain) throw new InvalidDomain();
      const rows = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, me.organizationId), eq(integrations.provider, "umbrella"), isNull(integrations.deletedAt)))
        .orderBy(asc(integrations.createdAt), asc(integrations.id));
      return { domain, integrations: await Promise.all(rows.map((row) => check(row, domain, refresh))) };
    },
  };
}

export type UmbrellaDomainCheckStore = ReturnType<typeof umbrellaDomainCheckStore>;
