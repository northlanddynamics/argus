import { and, eq } from "drizzle-orm";
import { virustotalLookups } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { reservedRange } from "../ipinfo/ipinfo";
import type { Membership } from "../members/membership";
import { normaliseObservable } from "../observables/vocabulary";
import { HASH_LOOKUP_FRESH_MS, HASH_LOOKUP_NOT_FOUND_FRESH_MS } from "./hash-lookups";
import { inFlight, memberKeys } from "./member-keys";
import { type DomainReport, NEWLY_REGISTERED_MS, type UrlReport, type VirustotalClient, withheldDomain } from "./virustotal";

/**
 * Looking domains, email addresses and URLs up on VirusTotal (ADR 0012), as hashes are (ADR 0011):
 * with each Member's own key, while they wait, cached for the Organization in `virustotal_lookups`.
 * A report is served for `DOMAIN_URL_LOOKUP_FRESH_MS`, "never seen" for
 * `DOMAIN_URL_LOOKUP_NOT_FOUND_FRESH_MS`; Refresh always asks; failures belong to the key
 * (`member-keys.ts`).
 *
 * - An email address is looked up by its domain alone: the mailbox name never leaves Argus.
 * - A URL is only looked up, never submitted for scanning, so VirusTotal never visits it.
 * - Names only meaningful inside a network (`.local`, `.internal`, `.corp`, …), URLs on reserved
 *   addresses, and URLs that carry a username or password are never sent (`withheld`): they say
 *   nothing to VirusTotal and would tell it about the Organization.
 */

/** How long a domain's or URL's report is served without asking VirusTotal again. */
export const DOMAIN_URL_LOOKUP_FRESH_MS = HASH_LOOKUP_FRESH_MS;
/** How long "VirusTotal has never seen it" is believed. */
export const DOMAIN_URL_LOOKUP_NOT_FOUND_FRESH_MS = HASH_LOOKUP_NOT_FOUND_FRESH_MS;

/** The value asked about isn't a domain name or an email address. */
export class InvalidDomain extends Error {
  constructor() {
    super("That isn't a domain name or an email address");
  }
}

/** The value asked about isn't an http, https or ftp URL. */
export class InvalidUrl extends Error {
  constructor() {
    super("That isn't an http, https or ftp URL");
  }
}

/**
 * - `found`: VirusTotal's report, as of `fetchedAt`.
 * - `not_found`: VirusTotal had never seen it, as of `fetchedAt`.
 * - `no_key`: nothing is cached, and the Member has no key to look it up with.
 * - `failed`: the lookup failed with `error`; `report` is what was cached before, if anything.
 * - `withheld`: it is never sent to VirusTotal, for the reason in `withheld`.
 */
export type DomainUrlLookupState = "found" | "not_found" | "no_key" | "failed" | "withheld";

type Lookup<R> = {
  state: DomainUrlLookupState;
  report: R | null;
  fetchedAt: string | null;
  error: string | null;
  /** Why it is never sent to VirusTotal, when it isn't. */
  withheld: string | null;
  /** Whether the Member could look it up again. */
  hasKey: boolean;
};

/**
 * What is known about a domain. `domain` is what was looked up: an email address's own domain.
 * `newlyRegistered`: the report says it was registered less than `NEWLY_REGISTERED_MS` ago.
 */
export type DomainLookup = Lookup<DomainReport> & { domain: string; newlyRegistered: boolean };
export type UrlLookup = Lookup<UrlReport> & { url: string };

type Kind = "domain" | "url";
type Cached = typeof virustotalLookups.$inferSelect;

/** A domain name, or the domain of an email address, in lowercase ASCII; null if it is neither. */
export function domainOf(raw: string) {
  const domain = normaliseObservable("domain", raw)?.value;
  if (domain) return domain;
  const email = normaliseObservable("email", raw)?.value;
  return email ? email.slice(email.lastIndexOf("@") + 1) : null;
}

/** Why `url` (as Argus normalises it) is never sent to VirusTotal, or null when it may be. */
export function withheldUrl(url: string): string | null {
  const u = new URL(url);
  if (u.username || u.password) return "URLs that carry a username or password aren't sent to VirusTotal";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ip = normaliseObservable("ip", host)?.value;
  if (ip) {
    const range = reservedRange(ip);
    return range ? `${range.label} addresses (${range.range}) mean nothing outside their own network, so they aren't sent to VirusTotal` : null;
  }
  return withheldDomain(host);
}

/** What `row` (cached for the value, if anything is) says, as a lookup; failed with `failed` when given. */
const answer = (row: Cached | undefined, hasKey: boolean, failed?: string): Lookup<DomainReport | UrlReport> => ({
  state: failed ? "failed" : !row ? "no_key" : row.found ? "found" : "not_found",
  report: row?.report ?? null,
  fetchedAt: row?.fetchedAt.toISOString() ?? null,
  error: failed ?? null,
  withheld: null,
  hasKey,
});

export function domainUrlLookupStore(deps: Pick<Deps, "db" | "clock" | "credentials" | "virustotal">) {
  const { db, clock } = deps;
  const keys = memberKeys(deps);
  const share = inFlight<Lookup<DomainReport | UrlReport>>();

  const store = async (organizationId: string, kind: Kind, value: string, report: DomainReport | UrlReport | null) => {
    const values = { found: report !== null, report, fetchedAt: clock.now() };
    const [row] = await db
      .insert(virustotalLookups)
      .values({ id: secureId(), organizationId, kind, value, ...values })
      .onConflictDoUpdate({ target: [virustotalLookups.organizationId, virustotalLookups.kind, virustotalLookups.value], set: values })
      .returning();
    return row!;
  };

  /** What is known about `value`: cached when fresh, else fetched with the Member's own key. */
  const resolve = async (
    me: Membership,
    kind: Kind,
    value: string,
    refresh: boolean,
    call: (client: VirustotalClient) => Promise<{ found: true; report: DomainReport | UrlReport } | { found: false }>,
  ): Promise<Lookup<DomainReport | UrlReport>> => {
    const [cached] = await db
      .select()
      .from(virustotalLookups)
      .where(and(eq(virustotalLookups.organizationId, me.organizationId), eq(virustotalLookups.kind, kind), eq(virustotalLookups.value, value)))
      .limit(1);
    const key = await keys.find(me);

    if (!refresh && cached) {
      const age = clock.now().getTime() - cached.fetchedAt.getTime();
      if (age < (cached.found ? DOMAIN_URL_LOOKUP_FRESH_MS : DOMAIN_URL_LOOKUP_NOT_FOUND_FRESH_MS)) return answer(cached, !!key);
    }
    if (!key) return answer(cached, false);
    const cooling = !refresh && keys.coolingDown(key);
    if (cooling) return answer(cached, true, cooling);
    const got = await keys.use(key, call);
    if ("error" in got) return answer(cached, true, got.error);
    return answer(await store(me.organizationId, kind, value, got.ok.found ? got.ok.report : null), true);
  };

  /** A lookup of something never sent. */
  const withheld = async (me: Membership, reason: string): Promise<Lookup<never>> => ({
    state: "withheld",
    report: null,
    fetchedAt: null,
    error: null,
    withheld: reason,
    hasKey: !!(await keys.find(me)),
  });

  return {
    /**
     * What VirusTotal knows about the domain `raw` names, or an email address `raw` is at (defanged
     * or not), fetched with the Member's own key when nothing fresh is cached, or always when
     * `refresh`. Members only.
     */
    async lookupDomain(me: Membership, raw: string, { refresh = false }: { refresh?: boolean } = {}): Promise<DomainLookup> {
      const domain = domainOf(raw);
      if (!domain) throw new InvalidDomain();
      const reason = withheldDomain(domain);
      if (reason) return { domain, newlyRegistered: false, ...(await withheld(me, reason)) };
      const got = (await share(`${me.memberId}:domain:${domain}:${refresh}`, () => resolve(me, "domain", domain, refresh, (c) => c.lookupDomain(domain)))) as Lookup<DomainReport>;
      const registeredAt = got.report?.registeredAt;
      const age = registeredAt ? clock.now().getTime() - new Date(registeredAt).getTime() : null;
      const newlyRegistered = age !== null && age >= 0 && age < NEWLY_REGISTERED_MS;
      return { domain, newlyRegistered, ...got };
    },

    /** What VirusTotal knows about the URL `raw` (defanged or not), as `lookupDomain`. Members only. */
    async lookupUrl(me: Membership, raw: string, { refresh = false }: { refresh?: boolean } = {}): Promise<UrlLookup> {
      const url = normaliseObservable("url", raw)?.value;
      if (!url) throw new InvalidUrl();
      const reason = withheldUrl(url);
      if (reason) return { url, ...(await withheld(me, reason)) };
      const got = await share(`${me.memberId}:url:${url}:${refresh}`, () => resolve(me, "url", url, refresh, (c) => c.lookupUrl(url)));
      return { url, ...(got as Lookup<UrlReport>) };
    },
  };
}

export type DomainUrlLookupStore = ReturnType<typeof domainUrlLookupStore>;
