import { eq } from "drizzle-orm";
import { virustotalKeys } from "../db/schema";
import type { Deps } from "../deps";
import type { Membership } from "../members/membership";
import type { VirustotalClient } from "./virustotal";

/**
 * Making a lookup with a Member's own VirusTotal key (ADR 0011), the same for files, domains and
 * URLs: the key is opened only to make the call, and what the call says about the key is recorded
 * on it. A refused key or a used-up quota is not tried again for `VIRUSTOTAL_RETRY_MS` unless its
 * Member asks for a refresh, so hovering doesn't cost a call each time. Another Member's key is
 * never used.
 */

/** How soon a key whose last lookup failed is tried again without a refresh. */
export const VIRUSTOTAL_RETRY_MS = 60_000;

export type MemberKey = typeof virustotalKeys.$inferSelect;

export function memberKeys({ db, clock, credentials: sealer, virustotal }: Pick<Deps, "db" | "clock" | "credentials" | "virustotal">) {
  return {
    /** The Member's own key, if they have set one. */
    async find(me: Membership): Promise<MemberKey | undefined> {
      return (await db.select().from(virustotalKeys).where(eq(virustotalKeys.memberId, me.memberId)).limit(1))[0];
    },

    /** The error `key`'s last lookup failed with, while it is too recent to try the key again. */
    coolingDown(key: MemberKey): string | null {
      return key.error && key.errorAt && clock.now().getTime() - key.errorAt.getTime() < VIRUSTOTAL_RETRY_MS ? key.error : null;
    },

    /**
     * Makes `call` with a client for `key`, recording on the key that it worked, or why it didn't.
     * Resolves to what `call` did, or to `{ error }`.
     */
    async use<T>(key: MemberKey, call: (client: VirustotalClient) => Promise<T>): Promise<{ ok: T } | { error: string }> {
      try {
        const { apiKey } = JSON.parse(await sealer.open(key.key)) as { apiKey: string };
        const ok = await call(virustotal({ apiKey }));
        await db.update(virustotalKeys).set({ lastUsedAt: clock.now(), error: null, errorAt: null }).where(eq(virustotalKeys.id, key.id));
        return { ok };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await db.update(virustotalKeys).set({ error, errorAt: clock.now() }).where(eq(virustotalKeys.id, key.id));
        return { error };
      }
    },
  };
}

/**
 * Shares one answer between the same Member asking the same thing again before the first answer is
 * back, from before the cache is read, so a burst of hovers can't read the cache before the first
 * fetch stores its answer and then fetch again.
 */
export function inFlight<T>() {
  const flights = new Map<string, Promise<T>>();
  return (key: string, start: () => Promise<T>) => {
    let flight = flights.get(key);
    if (!flight) {
      flight = start().finally(() => flights.delete(key));
      flights.set(key, flight);
    }
    return flight;
  };
}
