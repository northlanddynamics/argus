import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { WriteBackAction } from "../alerts/vocabulary";
import type { Db, Tx } from "../db/client";
import { falconWriteBacks, integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
import type { AlertPatch, FalconClient, FalconConnector } from "./falcon";
import { streamConnection } from "./stream-state";

/**
 * The Falcon write-back outbox (ADR 0002). Attaching an Alert, dismissing it, closing its Case and
 * changing its Case's Assignee each queue a write-back in the same transaction (`queueWriteBacks`),
 * so a write-back is queued exactly when the change commits, and survives restarts. The worker
 * sends them (`createWriteBackSender`), retrying failures with backoff.
 *
 * Only Integrations whose write-back is on get any. Turned off before one is sent, it is cancelled:
 * changes made while write-back is off are never sent.
 */

/** One Alert a write-back is about. */
export type WriteBackAlert = { id: string; integrationId: string; externalId: string };

/** What to write: `assigneeEmail` names the Falcon user to assign to (`assign` only; null unassigns). */
export type WriteBack = { action: WriteBackAction; falconStatus?: string; comment?: string; assigneeEmail?: string | null };

/** The comment added to an Alert in Falcon when it is attached to Case `number`: links to the Case. */
export const attachedComment = (c: { number: number; title: string }, baseUrl: string) =>
  `Attached to Argus Case C-${c.number} "${c.title}": ${new URL(`/cases/${c.number}`, baseUrl)}`;

/** The comment added to an Alert in Falcon when it is dismissed in Argus. */
export const dismissedComment = (by: string, reason: string, comment: string | null) =>
  `Dismissed in Argus by ${by}: ${reason}${comment ? ` (${comment})` : ""}`;

/** The comment added to an Alert in Falcon when its Case is closed. */
export const caseClosedComment = (c: { number: number; title: string }, by: string, resolution: string) =>
  `Argus Case C-${c.number} "${c.title}" was closed by ${by}: ${resolution}`;

/**
 * Queues `write` for each of `alerts` whose Integration has write-back on. Call it in the
 * transaction that makes the change. Returns how many were queued.
 */
export async function queueWriteBacks(tx: Tx, organizationId: string, alerts: readonly WriteBackAlert[], write: WriteBack, now: Date) {
  if (!alerts.length) return 0;
  const writing = new Set(
    (
      await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(
            inArray(integrations.id, [...new Set(alerts.map((a) => a.integrationId))]),
            eq(integrations.organizationId, organizationId),
            eq(integrations.writeBack, true),
          ),
        )
    ).map((r) => r.id),
  );
  const rows = alerts
    .filter((a) => writing.has(a.integrationId))
    .map((a) => ({
      id: secureId(),
      organizationId,
      integrationId: a.integrationId,
      alertId: a.id,
      externalId: a.externalId,
      action: write.action,
      falconStatus: write.falconStatus ?? null,
      comment: write.comment ?? null,
      assigneeEmail: write.action === "assign" ? (write.assigneeEmail ?? null) : null,
      state: "pending" as const,
      nextAttemptAt: now,
      createdAt: now,
    }));
  if (rows.length) await tx.insert(falconWriteBacks).values(rows);
  return rows.length;
}

/** How long the window of recent write-backs counted as sent, skipped or failed is. */
export const RECENT_WRITE_BACKS_MS = 24 * 60 * 60_000;

export type WriteBackCounts = {
  /** Waiting for their first attempt. */
  pending: number;
  /** Failed at least once and waiting to be tried again. */
  retrying: number;
  /** When the next retry is due, if any is. */
  nextRetryAt: string | null;
  /** Why the latest failure failed, while any write-back is retrying. */
  lastError: string | null;
  /** Within the last 24 hours. */
  sent: number;
  /** Within the last 24 hours: no Falcon user had the Case Assignee's email. */
  skipped: number;
  /** Within the last 24 hours: given up on after `MAX_WRITE_BACK_ATTEMPTS` failures. */
  failed: number;
};

const noWriteBacks: WriteBackCounts = { pending: 0, retrying: 0, nextRetryAt: null, lastError: null, sent: 0, skipped: 0, failed: 0 };

/** Each of `integrationIds`' write-backs, counted by where they stand. */
export async function writeBackCounts(db: Db | Tx, integrationIds: readonly string[], now: Date) {
  const counts = new Map<string, WriteBackCounts>(integrationIds.map((id) => [id, { ...noWriteBacks }]));
  if (!integrationIds.length) return counts;
  const since = new Date(now.getTime() - RECENT_WRITE_BACKS_MS);
  const w = falconWriteBacks;
  const retrying = sql`${w.state} = 'pending' AND ${w.attempts} > 0`;
  const recent = (state: string) => sql`${w.state} = ${state} AND ${w.finishedAt} >= ${since.toISOString()}::timestamptz`;
  const rows = await db
    .select({
      integrationId: w.integrationId,
      pending: sql<number>`count(*) FILTER (WHERE ${w.state} = 'pending' AND ${w.attempts} = 0)::int`,
      retrying: sql<number>`count(*) FILTER (WHERE ${retrying})::int`,
      nextRetryAt: sql<Date | null>`min(${w.nextAttemptAt}) FILTER (WHERE ${retrying})`,
      lastError: sql<string | null>`(array_agg(${w.lastError} ORDER BY ${w.seq} DESC) FILTER (WHERE ${retrying}))[1]`,
      sent: sql<number>`count(*) FILTER (WHERE ${recent("sent")})::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${recent("skipped")})::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${recent("failed")})::int`,
    })
    .from(w)
    .where(inArray(w.integrationId, [...integrationIds]))
    .groupBy(w.integrationId);
  for (const { integrationId, nextRetryAt, ...row } of rows) {
    counts.set(integrationId, { ...row, nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null });
  }
  return counts;
}

/** The most write-backs sent in one transaction. */
export const WRITE_BACK_BATCH = 100;
/** After this many failures a write-back is given up on. */
export const MAX_WRITE_BACK_ATTEMPTS = 10;
/** How long to wait before retrying a write-back that has failed `attempts` times: 30 s, doubling, at most an hour. */
export const retryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 60 * 60_000);

type Due = typeof falconWriteBacks.$inferSelect;

/**
 * Sends due write-backs to Falcon. Each batch is claimed with `FOR UPDATE SKIP LOCKED`, so however
 * many workers run, each write-back is sent by one. A write-back is due only once every earlier one
 * for the same Alert is done, so an Alert's changes reach Falcon in the order they were made, even
 * across retries. Integrations that are paused, or whose Organization was deleted, are left alone.
 */
export function createWriteBackSender(
  { db, clock, credentials }: Pick<Deps, "db" | "clock" | "credentials">,
  { connect }: { connect: FalconConnector },
) {
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

  /** Sends one batch; returns how many write-backs it finished or rescheduled. */
  const sendBatch = async () =>
    db.transaction(async (tx) => {
      const now = clock.now();
      const w = falconWriteBacks;
      const due = await tx
        .select({ row: w, writeBack: integrations.writeBack })
        .from(w)
        .innerJoin(integrations, eq(w.integrationId, integrations.id))
        .innerJoin(organization, eq(w.organizationId, organization.id))
        .where(
          and(
            eq(w.state, "pending"),
            lte(w.nextAttemptAt, now),
            eq(integrations.paused, false),
            isNull(organization.deletedAt),
            sql`NOT EXISTS (SELECT 1 FROM falcon_write_backs earlier
              WHERE earlier.alert_id = ${w.alertId} AND earlier.state = 'pending' AND earlier.seq < ${w.seq})`,
          ),
        )
        .orderBy(asc(w.seq))
        .limit(WRITE_BACK_BATCH)
        .for("update", { of: w, skipLocked: true });
      if (!due.length) return 0;

      const finish = async (rows: readonly Due[], state: "sent" | "skipped" | "cancelled", lastError: string | null = null) => {
        if (!rows.length) return;
        await tx
          .update(w)
          .set({ state, finishedAt: now, lastError })
          .where(inArray(w.id, rows.map((r) => r.id)));
      };
      const fail = async (rows: readonly Due[], error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        for (const row of rows) {
          const attempts = row.attempts + 1;
          const givenUp = attempts >= MAX_WRITE_BACK_ATTEMPTS;
          await tx
            .update(w)
            .set({
              attempts,
              lastError: message,
              ...(givenUp
                ? { state: "failed" as const, finishedAt: now }
                : { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) }),
            })
            .where(eq(w.id, row.id));
        }
      };

      const byIntegration = new Map<string, Due[]>();
      const cancelled: Due[] = [];
      for (const { row, writeBack } of due) {
        if (!writeBack) cancelled.push(row);
        else byIntegration.set(row.integrationId, [...(byIntegration.get(row.integrationId) ?? []), row]);
      }
      await finish(cancelled, "cancelled", "Write-back was turned off before this was sent");

      for (const [integrationId, rows] of byIntegration) {
        let client: FalconClient | null;
        try {
          client = await clientFor(integrationId);
        } catch (e) {
          await fail(rows, e);
          continue;
        }
        if (!client) {
          await finish(rows, "cancelled", "The Integration no longer exists");
          continue;
        }

        /** Falcon user UUIDs by email, looked up once per batch. */
        const users = new Map<string, string | null>();
        /** The same patch for several Alerts goes in one request. */
        const patches = new Map<string, { patch: AlertPatch; rows: Due[] }>();
        for (const row of rows) {
          const patch: AlertPatch = {};
          if (row.falconStatus !== null) patch.status = row.falconStatus;
          if (row.comment !== null) patch.comment = row.comment;
          if (row.action === "assign") {
            if (row.assigneeEmail === null) patch.assignTo = null;
            else {
              const email = row.assigneeEmail.toLowerCase();
              if (!users.has(email)) {
                try {
                  users.set(email, await client.findUser(email));
                } catch (e) {
                  await fail([row], e);
                  continue;
                }
              }
              const uuid = users.get(email);
              if (!uuid) {
                await finish([row], "skipped", `No Falcon user has the email ${row.assigneeEmail}`);
                continue;
              }
              patch.assignTo = uuid;
            }
          }
          const key = JSON.stringify(patch);
          const group = patches.get(key) ?? { patch, rows: [] };
          group.rows.push(row);
          patches.set(key, group);
        }

        for (const { patch, rows: group } of patches.values()) {
          try {
            await client.updateAlerts(
              group.map((r) => r.externalId),
              patch,
            );
            await finish(group, "sent");
          } catch (e) {
            await fail(group, e);
          }
        }
      }

      // The Integrations page shows the counts.
      for (const organizationId of new Set(due.map((d) => d.row.organizationId))) {
        await publish(tx, { kind: "alerts", organizationId });
      }
      return due.length;
    });

  let running: Promise<void> | null = null;
  return {
    /** Sends every write-back that is due, batch by batch. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
          for (let batch = 0; batch < 50; batch++) {
            if (!(await sendBatch())) return;
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

export type WriteBackSender = ReturnType<typeof createWriteBackSender>;
