import { and, desc, eq, sql } from "drizzle-orm";
import type { Severity } from "../cases/vocabulary";
import type { Detection } from "../crowdstrike/detections";
import type { Tx } from "../db/client";
import { alerts, integrations } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import type { AlertStatus } from "./vocabulary";

/**
 * Alerts: detections received from the Organization's Integrations. Every Member sees the Alert
 * queue; Guests never do. Alerts arrive through the worker (`recordDetection`).
 */

export type AlertFilter = { status?: AlertStatus; severity?: Severity; integrationId?: string };

/** The most Alerts the queue shows at once, newest first. */
const QUEUE_LIMIT = 500;

/**
 * Records a detection from `integration`: a new Alert with Status New, or, for a `CompositeId` already
 * received, the same Alert brought up to date (its Status unchanged). Its version moves on only when
 * something changed. Returns whether anything did. Call it in the transaction that stores the offset.
 */
export async function recordDetection(
  tx: Tx,
  integration: { id: string; organizationId: string },
  detection: Detection,
  now: Date,
) {
  const fields = {
    kind: detection.kind,
    severity: detection.severity,
    title: detection.title,
    description: detection.description,
    host: detection.host,
    userName: detection.userName,
    detectedAt: detection.detectedAt,
    payload: detection.payload,
  };
  const changed = await tx
    .insert(alerts)
    .values({
      id: secureId(),
      organizationId: integration.organizationId,
      integrationId: integration.id,
      externalId: detection.externalId,
      status: "new",
      version: 1,
      receivedAt: now,
      updatedAt: now,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [alerts.integrationId, alerts.externalId],
      set: {
        kind: sql`excluded.kind`,
        severity: sql`excluded.severity`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        host: sql`excluded.host`,
        userName: sql`excluded.user_name`,
        detectedAt: sql`excluded.detected_at`,
        payload: sql`excluded.payload`,
        version: sql`${alerts.version} + 1`,
        updatedAt: now,
      },
      // A detection delivered again unchanged leaves its Alert as it was.
      setWhere: sql`(${alerts.kind}, ${alerts.severity}, ${alerts.title}, ${alerts.description}, ${alerts.host}, ${alerts.userName}, ${alerts.detectedAt}, ${alerts.payload})
        IS DISTINCT FROM (excluded.kind, excluded.severity, excluded.title, excluded.description, excluded.host, excluded.user_name, excluded.detected_at, excluded.payload)`,
    })
    .returning({ id: alerts.id });
  return changed.length > 0;
}

export function alertStore({ db }: Pick<Deps, "db">) {
  return {
    /** The Alert queue: the Organization's Alerts matching `filter`, newest first. */
    async list(me: Membership, filter: AlertFilter = {}) {
      const rows = await db
        .select({
          id: alerts.id,
          externalId: alerts.externalId,
          kind: alerts.kind,
          status: alerts.status,
          severity: alerts.severity,
          title: alerts.title,
          host: alerts.host,
          userName: alerts.userName,
          detectedAt: alerts.detectedAt,
          receivedAt: alerts.receivedAt,
          version: alerts.version,
          integrationId: integrations.id,
          integrationName: integrations.name,
        })
        .from(alerts)
        .innerJoin(integrations, eq(alerts.integrationId, integrations.id))
        .where(
          and(
            eq(alerts.organizationId, me.organizationId),
            filter.status ? eq(alerts.status, filter.status) : undefined,
            filter.severity ? eq(alerts.severity, filter.severity) : undefined,
            filter.integrationId ? eq(alerts.integrationId, filter.integrationId) : undefined,
          ),
        )
        .orderBy(desc(alerts.receivedAt), desc(alerts.seq))
        .limit(QUEUE_LIMIT);
      return rows.map(({ integrationId, integrationName, detectedAt, receivedAt, ...row }) => ({
        ...row,
        integration: { id: integrationId, name: integrationName },
        detectedAt: detectedAt?.toISOString() ?? null,
        receivedAt: receivedAt.toISOString(),
      }));
    },
  };
}

export type AlertStore = ReturnType<typeof alertStore>;
