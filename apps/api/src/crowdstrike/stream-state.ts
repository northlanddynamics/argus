import { and, eq, isNull } from "drizzle-orm";
import { recordDetection } from "../alerts/alerts";
import type { IntegrationHealth } from "../alerts/vocabulary";
import { recordOrgAudit } from "../audit/org-audit-log";
import type { Clock } from "../clock";
import type { Db } from "../db/client";
import { integrations, organization } from "../db/schema";
import type { CredentialSealer } from "../integrations/credentials";
import { publish } from "../realtime/signals";
import { readDetection } from "./detections";
import type { FalconConnection, StreamEvent } from "./falcon";

/**
 * What the worker reads and writes about Integrations' streams. Like every module (ADR 0006), only
 * this touches the database on the worker's behalf; each change commits with its audit entry and
 * live signal.
 */

/** The Integrations a worker should be streaming, unless paused, in Organizations that still exist. */
export async function streamTargets(db: Db) {
  return db
    .select({ id: integrations.id, paused: integrations.paused, credentialsRevision: integrations.credentialsRevision })
    .from(integrations)
    .innerJoin(organization, eq(integrations.organizationId, organization.id))
    .where(isNull(organization.deletedAt));
}

/** The name an Integration's stream is read under: one per Integration, as Falcon requires. */
const appIdFor = (integrationId: string) => `argus${integrationId.slice(0, 16)}`;

/** What it takes to connect an Integration's stream, credentials opened; null if it no longer exists. */
export async function streamConnection(db: Db, sealer: CredentialSealer, integrationId: string) {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
  if (!row) return null;
  const credentials = JSON.parse(await sealer.open(row.credentials)) as FalconConnection["credentials"];
  return {
    connection: { cloud: row.cloud, credentials, appId: appIdFor(row.id) } satisfies FalconConnection,
    credentialsRevision: row.credentialsRevision,
    /** Where to read from: just after the last event processed, or the oldest event Falcon holds. */
    resumeFrom: row.streamOffset === null ? 0 : row.streamOffset + 1,
  };
}

export type HealthReport = {
  health: IntegrationHealth;
  detail?: string | null;
  workerId: string | null;
  sessionRefreshAt?: Date | null;
};

/** Records how the Integration's stream is doing, as its worker sees it. */
export async function reportHealth(db: Db, clock: Clock, integrationId: string, report: HealthReport) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(integrations)
      .set({
        health: report.health,
        healthDetail: report.detail ?? null,
        healthChangedAt: clock.now(),
        workerId: report.workerId,
        ...(report.sessionRefreshAt !== undefined && { sessionRefreshAt: report.sessionRefreshAt }),
      })
      .where(eq(integrations.id, integrationId))
      .returning({ organizationId: integrations.organizationId });
    if (row) await publish(tx, { kind: "alerts", organizationId: row.organizationId });
  });
}

/** A worker let go of the stream (paused, or shutting down): it waits for a worker again. */
export async function reportReleased(db: Db, clock: Clock, integrationId: string, workerId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(integrations)
      .set({ workerId: null, sessionRefreshAt: null, health: "connecting", healthDetail: null, healthChangedAt: clock.now() })
      .where(and(eq(integrations.id, integrationId), eq(integrations.workerId, workerId)))
      .returning({ organizationId: integrations.organizationId });
    if (row) await publish(tx, { kind: "alerts", organizationId: row.organizationId });
  });
}

/** When the stream session must next be refreshed by. */
export async function reportSessionRefresh(db: Db, integrationId: string, at: Date) {
  await db.update(integrations).set({ sessionRefreshAt: at }).where(eq(integrations.id, integrationId));
}

/**
 * Processes one event from the Integration's stream, once: an event at or before the stored offset
 * was processed already and is skipped. A detection becomes or updates an Alert. An event past the
 * next expected offset means Falcon no longer holds those in between: the gap is recorded in the
 * Organization Audit Log, and not backfilled. The offset is stored with the result.
 */
export async function processStreamEvent(db: Db, clock: Clock, integrationId: string, event: StreamEvent) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: integrations.id,
        organizationId: integrations.organizationId,
        name: integrations.name,
        streamOffset: integrations.streamOffset,
      })
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .for("update")
      .limit(1);
    if (!row) return;
    const last = row.streamOffset;
    if (last !== null && event.offset <= last) return;
    const now = clock.now();

    const gap = last !== null && event.offset > last + 1 ? { fromOffset: last + 1, toOffset: event.offset - 1 } : null;
    if (gap) {
      await recordOrgAudit(tx, {
        organizationId: row.organizationId,
        occurredAt: now,
        actor: { type: "system" },
        category: "integrations",
        action: "integration.stream_gap",
        target: row.name,
        before: `offset ${last}`,
        after: `offset ${event.offset}`,
      });
    }

    const detection = readDetection(event);
    if (detection) await recordDetection(tx, row, detection, now);

    await tx
      .update(integrations)
      .set({
        streamOffset: event.offset,
        lastEventAt: now,
        ...(gap && { lastGapAt: now, lastGapFromOffset: gap.fromOffset, lastGapToOffset: gap.toOffset }),
      })
      .where(eq(integrations.id, integrationId));
    await publish(tx, { kind: "alerts", organizationId: row.organizationId });
  });
}
