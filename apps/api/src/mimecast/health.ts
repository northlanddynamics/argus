import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import type { IntegrationHealth } from "../alerts/vocabulary";
import type { Db } from "../db/client";
import { integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { openCredentials } from "../integrations/credentials";
import { publish } from "../realtime/signals";
import { type MimecastConnector, MimecastRefused } from "./mimecast";

/**
 * The worker's health checks for Mimecast Integrations, which have no stream to show how they are
 * doing: it signs in with each one's credentials when it is added, its credentials are rotated or it
 * is resumed (its health is then Connecting), and again every `MIMECAST_CHECK_INTERVAL_MS`. Accepted,
 * it is Connected; refused, Error with Mimecast's reason; unreachable, Reconnecting until the next
 * check. Paused Integrations, and those of deleted Organizations, are left alone. A check made twice
 * by two workers at once is harmless.
 */

/** How often credentials that were checked are checked again. */
export const MIMECAST_CHECK_INTERVAL_MS = 15 * 60_000;
/** How soon a check that couldn't reach Mimecast is tried again. */
export const MIMECAST_RECHECK_MS = 60_000;

/** The Mimecast Integrations whose credentials are due to be checked. */
async function due(db: Db, now: Date) {
  const i = integrations;
  return db
    .select({ id: i.id, organizationId: i.organizationId, credentials: i.credentials, credentialsRevision: i.credentialsRevision })
    .from(i)
    .innerJoin(organization, eq(i.organizationId, organization.id))
    .where(
      and(
        eq(i.provider, "mimecast"),
        eq(i.paused, false),
        isNull(organization.deletedAt),
        or(
          eq(i.health, "connecting"),
          isNull(i.healthCheckedAt),
          and(eq(i.health, "disconnected"), lt(i.healthCheckedAt, new Date(now.getTime() - MIMECAST_RECHECK_MS))),
          and(ne(i.health, "disconnected"), lt(i.healthCheckedAt, new Date(now.getTime() - MIMECAST_CHECK_INTERVAL_MS))),
        ),
      ),
    );
}

export function createMimecastHealthChecker({ db, clock, credentials: sealer }: Pick<Deps, "db" | "clock" | "credentials">, { connect }: { connect: MimecastConnector }) {
  /** Records what a check found, unless the credentials were rotated while it was made. */
  const record = async (row: { id: string; credentialsRevision: number }, health: IntegrationHealth, detail: string | null) => {
    const now = clock.now();
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ health: integrations.health, healthDetail: integrations.healthDetail, organizationId: integrations.organizationId })
        .from(integrations)
        .where(and(eq(integrations.id, row.id), eq(integrations.credentialsRevision, row.credentialsRevision), eq(integrations.paused, false)))
        .for("update");
      if (!current) return;
      const changed = current.health !== health || current.healthDetail !== detail;
      await tx
        .update(integrations)
        .set({ healthCheckedAt: now, ...(changed && { health, healthDetail: detail, healthChangedAt: now }) })
        .where(eq(integrations.id, row.id));
      if (changed) await publish(tx, { kind: "alerts", organizationId: current.organizationId });
    });
  };

  let running: Promise<void> | null = null;
  return {
    /** Checks every Integration that is due. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
          for (const row of await due(db, clock.now())) {
            try {
              await connect(await openCredentials(sealer, "mimecast", row.credentials)).check();
              await record(row, "connected", null);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              await record(row, e instanceof MimecastRefused ? "error" : "disconnected", message);
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

export type MimecastHealthChecker = ReturnType<typeof createMimecastHealthChecker>;

