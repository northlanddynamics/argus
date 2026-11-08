import { and, eq, isNull, lt, or } from "drizzle-orm";
import { integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { openCredentials } from "../integrations/credentials";
import { type IpinfoConnector, IpinfoQuotaExceeded, IpinfoRefused } from "./ipinfo";
import { recordIpinfoHealth } from "./ip-lookups";

/**
 * The worker's check of an IPinfo Integration's token when it is added, rotated or resumed (its
 * health is then Connecting), and again a minute after a check that couldn't reach IPinfo. Unlike
 * Mimecast's (`mimecast/health.ts`) it is not repeated on a schedule: each check spends a lookup from
 * the token's quota, and every lookup Members make already reports how the token is doing
 * (`ip-lookups.ts`). Paused Integrations, and those of deleted Organizations, are left alone.
 */

/** How soon a check that couldn't reach IPinfo is tried again. */
export const IPINFO_RECHECK_MS = 60_000;

/** The address looked up to check a token: one IPinfo always knows. */
export const IPINFO_CHECK_IP = "8.8.8.8";

export function createIpinfoHealthChecker(deps: Pick<Deps, "db" | "clock" | "credentials">, { connect }: { connect: IpinfoConnector }) {
  const { db, clock, credentials: sealer } = deps;
  let running: Promise<void> | null = null;
  return {
    /** Checks every IPinfo Integration that is due. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
          const i = integrations;
          const due = await db
            .select({ id: i.id, organizationId: i.organizationId, credentials: i.credentials, credentialsRevision: i.credentialsRevision })
            .from(i)
            .innerJoin(organization, eq(i.organizationId, organization.id))
            .where(
              and(
                eq(i.provider, "ipinfo"),
                eq(i.paused, false),
                isNull(organization.deletedAt),
                or(eq(i.health, "connecting"), and(eq(i.health, "disconnected"), lt(i.healthCheckedAt, new Date(clock.now().getTime() - IPINFO_RECHECK_MS)))),
              ),
            );
          for (const row of due) {
            try {
              await connect(await openCredentials(sealer, "ipinfo", row.credentials)).lookup(IPINFO_CHECK_IP);
              await recordIpinfoHealth(deps, row, "connected", null);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              const refused = e instanceof IpinfoRefused || e instanceof IpinfoQuotaExceeded;
              await recordIpinfoHealth(deps, row, refused ? "error" : "disconnected", message);
            }
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
