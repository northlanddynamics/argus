import { and, eq } from "drizzle-orm";
import { hashLookups, virustotalKeys } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { normaliseObservable } from "../observables/vocabulary";
import { type FileReport, type HashType, hashTypeOf, VirustotalRefused } from "./virustotal";

/**
 * Looking files up on VirusTotal by hash (ADR 0011), for any Member, each with their own API key,
 * with the answers cached per Organization in `hash_lookups`. A cached answer younger than
 * `HASH_LOOKUP_FRESH_MS` (`HASH_LOOKUP_NOT_FOUND_FRESH_MS` for a file VirusTotal hasn't seen) is
 * served as it is, to any Member, whether they have set a key or not; an older one, or none, is
 * fetched with the Member's key while they wait. Refresh always fetches.
 *
 * A failed fetch keeps the cached answer and says why. What went wrong is recorded on the key, not
 * the cache, since it is that key's problem: a refused key or a used-up quota is not tried again for
 * `HASH_LOOKUP_RETRY_MS` unless its Member asks for a refresh, so hovering doesn't cost a call each
 * time. Another Member's key is never used.
 */

/** How long a file's report is served without asking VirusTotal again: engines' verdicts change. */
export const HASH_LOOKUP_FRESH_MS = 24 * 60 * 60_000;
/** How long "VirusTotal has never seen it" is believed: a file may be submitted at any time. */
export const HASH_LOOKUP_NOT_FOUND_FRESH_MS = 60 * 60_000;
/** How soon a key whose last lookup failed is tried again without a refresh. */
export const HASH_LOOKUP_RETRY_MS = 60_000;

/** A file whose hashes are all known, looked up to check a new key: the EICAR test file. */
export const VIRUSTOTAL_CHECK_HASH = "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f";

/** The value asked about isn't an MD5, SHA-1 or SHA-256 hash. */
export class InvalidHash extends Error {
  constructor() {
    super("That isn't an MD5, SHA-1 or SHA-256 hash");
  }
}

/** VirusTotal refused the key offered: it isn't saved. */
export class KeyRefused extends Error {}

/**
 * - `found`: VirusTotal's report, as of `fetchedAt`.
 * - `not_found`: VirusTotal had never seen the file, as of `fetchedAt`.
 * - `no_key`: nothing is cached, and the Member has no key to look it up with.
 * - `failed`: the lookup failed with `error`; `report` is what was cached before, if anything.
 *
 * `hasKey` says whether the Member could look it up again; without one, a `found` or `not_found`
 * answer may be older than it would be refreshed at.
 */
export type HashLookupState = "found" | "not_found" | "no_key" | "failed";

export type HashLookup = {
  /** The hash in lowercase hex. */
  hash: string;
  hashType: HashType;
  state: HashLookupState;
  report: FileReport | null;
  fetchedAt: string | null;
  error: string | null;
  hasKey: boolean;
};

/** A Member's key as they see it: never the key itself. */
export type VirustotalKeyView = { hint: string; updatedAt: string; lastUsedAt: string | null; error: string | null; errorAt: string | null };

type Cached = typeof hashLookups.$inferSelect;
type Key = typeof virustotalKeys.$inferSelect;

const hintOf = (apiKey: string) => `…${apiKey.slice(-4)}`;

const view = (k: Key): VirustotalKeyView => ({
  hint: k.hint,
  updatedAt: k.updatedAt.toISOString(),
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  error: k.error,
  errorAt: k.errorAt?.toISOString() ?? null,
});

/** What `row` (cached for `hash`, if anything is) says, as a lookup; failed with `failed` when given. */
const answer = (hash: string, hashType: HashType, row: Cached | undefined, hasKey: boolean, failed?: string): HashLookup => ({
  hash,
  hashType,
  state: failed ? "failed" : !row ? "no_key" : row.found ? "found" : "not_found",
  report: row?.report ?? null,
  fetchedAt: row?.fetchedAt.toISOString() ?? null,
  error: failed ?? null,
  hasKey,
});

export function hashLookupStore({ db, clock, credentials: sealer, virustotal }: Pick<Deps, "db" | "clock" | "credentials" | "virustotal">) {
  /** Lookups being fetched now, by key and hash, so a burst of hovers on one hash costs one call. */
  const inFlight = new Map<string, Promise<HashLookup>>();

  const findKey = async (me: Membership) => (await db.select().from(virustotalKeys).where(eq(virustotalKeys.memberId, me.memberId)).limit(1))[0];

  const openKey = async (k: Key) => (JSON.parse(await sealer.open(k.key)) as { apiKey: string }).apiKey;

  /** Stores what VirusTotal said about `hash`: under each of the file's hashes when it was found. */
  const store = async (organizationId: string, hash: string, report: FileReport | null) => {
    const now = clock.now();
    const hashes = new Set([hash, ...(report ? [report.md5, report.sha1, report.sha256].filter((h): h is string => !!h && !!hashTypeOf(h)) : [])]);
    const values = { found: report !== null, report, fetchedAt: now };
    const rows = await db
      .insert(hashLookups)
      .values([...hashes].map((h) => ({ id: secureId(), organizationId, hash: h, ...values })))
      .onConflictDoUpdate({ target: [hashLookups.organizationId, hashLookups.hash], set: values })
      .returning();
    return rows.find((r) => r.hash === hash)!;
  };

  const fetchAndStore = async (me: Membership, key: Key, hash: string, hashType: HashType, cached: Cached | undefined): Promise<HashLookup> => {
    try {
      const got = await virustotal({ apiKey: await openKey(key) }).lookup(hash);
      const row = await store(me.organizationId, hash, got.found ? got.report : null);
      await db.update(virustotalKeys).set({ lastUsedAt: clock.now(), error: null, errorAt: null }).where(eq(virustotalKeys.id, key.id));
      return answer(hash, hashType, row, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.update(virustotalKeys).set({ error: message, errorAt: clock.now() }).where(eq(virustotalKeys.id, key.id));
      return answer(hash, hashType, cached, true, message);
    }
  };

  return {
    /**
     * What is known about the file `raw` (an MD5, SHA-1 or SHA-256 hash, any case) identifies,
     * fetched from VirusTotal with the Member's own key when nothing fresh is cached, or always when
     * `refresh`. Members only.
     */
    async lookup(me: Membership, raw: string, { refresh = false }: { refresh?: boolean } = {}): Promise<HashLookup> {
      const text = raw.trim();
      const hashType = hashTypeOf(text.toLowerCase());
      const hash = hashType && normaliseObservable(hashType, text)?.value;
      if (!hashType || !hash) throw new InvalidHash();

      const [cached] = await db
        .select()
        .from(hashLookups)
        .where(and(eq(hashLookups.organizationId, me.organizationId), eq(hashLookups.hash, hash)))
        .limit(1);
      const key = await findKey(me);
      const now = clock.now().getTime();

      if (!refresh && cached) {
        const age = now - cached.fetchedAt.getTime();
        if (age < (cached.found ? HASH_LOOKUP_FRESH_MS : HASH_LOOKUP_NOT_FOUND_FRESH_MS)) return answer(hash, hashType, cached, !!key);
      }
      if (!key) return answer(hash, hashType, cached, false);
      if (!refresh && key.error && key.errorAt && now - key.errorAt.getTime() < HASH_LOOKUP_RETRY_MS) {
        return answer(hash, hashType, cached, true, key.error);
      }

      const flightKey = `${key.id}:${hash}`;
      let flight = inFlight.get(flightKey);
      if (!flight) {
        flight = fetchAndStore(me, key, hash, hashType, cached).finally(() => inFlight.delete(flightKey));
        inFlight.set(flightKey, flight);
      }
      return flight;
    },

    /** The Member's own key, as they see it, or null. */
    async key(me: Membership) {
      const k = await findKey(me);
      return k ? view(k) : null;
    },

    /**
     * Sets or replaces the Member's own key, after checking it by looking up a file VirusTotal is
     * sure to know. A refused key is not saved (`KeyRefused`); one whose quota is used up, or that
     * couldn't be checked, is saved with that as its error.
     */
    async setKey(me: Membership, apiKey: string): Promise<VirustotalKeyView> {
      let error: string | null = null;
      try {
        const got = await virustotal({ apiKey }).lookup(VIRUSTOTAL_CHECK_HASH);
        await store(me.organizationId, VIRUSTOTAL_CHECK_HASH, got.found ? got.report : null);
      } catch (e) {
        if (e instanceof VirustotalRefused) throw new KeyRefused(e.message);
        error = e instanceof Error ? e.message : String(e);
      }
      const now = clock.now();
      const values = { key: await sealer.seal(JSON.stringify({ apiKey })), hint: hintOf(apiKey), updatedAt: now, lastUsedAt: error ? null : now, error, errorAt: error ? now : null };
      const [row] = await db
        .insert(virustotalKeys)
        .values({ id: secureId(), organizationId: me.organizationId, memberId: me.memberId, createdAt: now, ...values })
        .onConflictDoUpdate({ target: virustotalKeys.memberId, set: values })
        .returning();
      return view(row!);
    },

    /** Removes the Member's own key. What it looked up stays cached for the Organization. */
    async removeKey(me: Membership) {
      const removed = await db.delete(virustotalKeys).where(eq(virustotalKeys.memberId, me.memberId)).returning({ id: virustotalKeys.id });
      return removed.length > 0;
    },
  };
}

export type HashLookupStore = ReturnType<typeof hashLookupStore>;
