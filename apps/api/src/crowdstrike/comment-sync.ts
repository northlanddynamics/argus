import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client";
import { alertFalconComments, alerts, cases, falconWriteBacks, integrations, organization } from "../db/schema";
import type { Deps } from "../deps";
import { postFalconComments } from "../discussion/discussion";
import { secureId } from "../ids";
import { providersThat } from "../integrations/vocabulary";
import { publish } from "../realtime/signals";
import type { FalconClient, FalconComment, FalconConnector } from "./falcon";
import { streamConnection } from "./stream-state";

/**
 * Comments made on Alerts in Falcon (ADR 0002). They are not reliably in the stream, so Argus asks
 * Falcon for an Alert's comments when a `detection_update` names it, when it is attached to a Case,
 * and when someone opens it or its Case (`requestCommentSync`). Asking only marks the Alert due; the
 * worker fetches due Alerts' comments (`createCommentSyncer`), so opening a page never waits on Falcon.
 *
 * Each comment is held once per Alert by its identity in Falcon (`alert_falcon_comments`). While the
 * Alert is attached to a Case that isn't Closed, each is posted into the Case's Discussion as an
 * Internal message attributed to "CrowdStrike: <user>", once. Comments Argus wrote to Falcon itself
 * (write-backs) are not synced back.
 */

/** Opening an Alert or Case asks again only once this long has passed since the last fetch. */
export const COMMENT_REFRESH_INTERVAL_MS = 60_000;
/** The most Alerts whose comments are fetched in one batch. */
export const COMMENT_SYNC_BATCH = 50;

/**
 * Marks `alertIds` due for a comment fetch. With `ifStale`, as when someone opens an Alert or its
 * Case, Alerts fetched within `COMMENT_REFRESH_INTERVAL_MS` are left alone.
 */
export async function requestCommentSync(db: Db | Tx, alertIds: readonly string[], now: Date, { ifStale = false } = {}) {
  if (!alertIds.length) return;
  const since = new Date(now.getTime() - COMMENT_REFRESH_INTERVAL_MS);
  await db
    .update(alerts)
    .set({ falconCommentsDue: true })
    .where(
      and(
        inArray(alerts.id, [...alertIds]),
        eq(alerts.falconCommentsDue, false),
        ifStale ? or(isNull(alerts.falconCommentsSyncedAt), lt(alerts.falconCommentsSyncedAt, since)) : undefined,
      ),
    );
}

/** Marks the comments of every Alert attached to Case `caseId` due, unless fetched recently. */
export async function requestCaseCommentSync(db: Db | Tx, caseId: string, now: Date) {
  const attached = await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.caseId, caseId));
  await requestCommentSync(
    db,
    attached.map((a) => a.id),
    now,
    { ifStale: true },
  );
}

/** Where fetching an Alert's comments from Falcon stands, as the Alert's page shows it. */
export type FalconCommentsView = {
  /** A fetch is wanted and the worker hasn't done it yet. */
  refreshing: boolean;
  syncedAt: string | null;
  /** Why the last fetch failed, if it did. */
  error: string | null;
  comments: { id: string; author: string | null; body: string; createdAt: string | null }[];
};

/** The Alert's comments in Falcon as last fetched, oldest first, and whether a fetch is under way. */
export async function falconCommentsOf(
  db: Db | Tx,
  alert: { id: string; falconCommentsDue: boolean; falconCommentsSyncedAt: Date | null; falconCommentsError: string | null },
): Promise<FalconCommentsView> {
  const rows = await db
    .select()
    .from(alertFalconComments)
    .where(eq(alertFalconComments.alertId, alert.id))
    .orderBy(sql`${alertFalconComments.createdAt} ASC NULLS LAST`, asc(alertFalconComments.seq));
  return {
    refreshing: alert.falconCommentsDue,
    syncedAt: alert.falconCommentsSyncedAt?.toISOString() ?? null,
    error: alert.falconCommentsError,
    comments: rows.map((r) => ({ id: r.id, author: r.author, body: r.body, createdAt: r.createdAt?.toISOString() ?? null })),
  };
}

type Claimed = { id: string; organizationId: string; integrationId: string; externalId: string };

/**
 * Stores what one fetch of `alert`'s comments returned (or why it failed), and posts the comments
 * not yet in the Discussion of the Case it is attached to now.
 */
async function storeFetched(tx: Tx, alert: Claimed, fetched: FalconComment[] | { error: string }, now: Date) {
  const [current] = await tx
    .select({ caseId: alerts.caseId, title: alerts.title, externalId: alerts.externalId })
    .from(alerts)
    .where(eq(alerts.id, alert.id))
    .for("update");
  if (!current) return;

  if ("error" in fetched) {
    await tx.update(alerts).set({ falconCommentsSyncedAt: now, falconCommentsError: fetched.error }).where(eq(alerts.id, alert.id));
    return;
  }
  // What Argus wrote to Falcon itself comes back as comments; those aren't Falcon users' words.
  const ours = new Set(
    (
      await tx
        .select({ comment: falconWriteBacks.comment })
        .from(falconWriteBacks)
        .where(and(eq(falconWriteBacks.alertId, alert.id), sql`${falconWriteBacks.comment} IS NOT NULL`))
    ).map((w) => w.comment!.trim()),
  );
  const fresh = fetched.filter((c) => !ours.has(c.body.trim()));
  if (fresh.length) {
    await tx
      .insert(alertFalconComments)
      .values(
        fresh.map((c) => ({
          id: secureId(),
          organizationId: alert.organizationId,
          alertId: alert.id,
          falconCommentId: c.id,
          author: c.author,
          body: c.body,
          createdAt: c.createdAt,
          fetchedAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  await tx.update(alerts).set({ falconCommentsSyncedAt: now, falconCommentsError: null }).where(eq(alerts.id, alert.id));

  if (!current.caseId) return;
  const [onCase] = await tx.select({ status: cases.status }).from(cases).where(eq(cases.id, current.caseId));
  // A Closed Case's Discussion takes no new messages.
  if (!onCase || onCase.status === "closed") return;
  const held = await tx
    .select()
    .from(alertFalconComments)
    .where(eq(alertFalconComments.alertId, alert.id))
    .orderBy(sql`${alertFalconComments.createdAt} ASC NULLS LAST`, asc(alertFalconComments.seq));
  await postFalconComments(
    tx,
    { id: alert.id, organizationId: alert.organizationId, caseId: current.caseId, title: current.title, externalId: current.externalId },
    held.map((h) => ({ falconCommentId: h.falconCommentId, author: h.author, body: h.body, createdAt: h.createdAt })),
    now,
  );
}

/**
 * Fetches the comments of Alerts marked due. Each batch is claimed in a short transaction with
 * `FOR UPDATE SKIP LOCKED`, which clears the mark, so however many workers run each fetch is made by
 * one, and no row stays locked while Falcon answers. Asked for again meanwhile, an Alert is due
 * again and fetched once more. Alerts of paused Integrations, or deleted Organizations, wait.
 */
export function createCommentSyncer(
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

  const claim = () =>
    db.transaction(async (tx) => {
      const due = await tx
        .select({ id: alerts.id, organizationId: alerts.organizationId, integrationId: alerts.integrationId, externalId: alerts.externalId })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .innerJoin(organization, eq(alerts.organizationId, organization.id))
        .where(
          and(
            eq(alerts.falconCommentsDue, true),
            eq(integrations.paused, false),
            inArray(integrations.provider, providersThat("receivesAlerts")),
            isNull(organization.deletedAt),
          ),
        )
        .orderBy(asc(alerts.seq))
        .limit(COMMENT_SYNC_BATCH)
        .for("update", { of: alerts, skipLocked: true });
      if (due.length) {
        await tx
          .update(alerts)
          .set({ falconCommentsDue: false })
          .where(
            inArray(
              alerts.id,
              due.map((d) => d.id),
            ),
          );
      }
      return due;
    });

  const syncBatch = async () => {
    const due = await claim();
    for (const alert of due) {
      let fetched: FalconComment[] | { error: string };
      try {
        const client = await clientFor(alert.integrationId);
        fetched = client ? await client.alertComments(alert.externalId) : { error: "The Integration no longer exists" };
      } catch (e) {
        fetched = { error: e instanceof Error ? e.message : String(e) };
      }
      await db.transaction((tx) => storeFetched(tx, alert, fetched, clock.now()));
    }
    if (due.length) {
      await db.transaction(async (tx) => {
        for (const organizationId of new Set(due.map((d) => d.organizationId))) await publish(tx, { kind: "alerts", organizationId });
      });
    }
    return due.length;
  };

  let running: Promise<void> | null = null;
  return {
    /** Fetches every due Alert's comments, batch by batch. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
          for (let batch = 0; batch < 20; batch++) {
            if ((await syncBatch()) < COMMENT_SYNC_BATCH) return;
          }
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

export type CommentSyncer = ReturnType<typeof createCommentSyncer>;
