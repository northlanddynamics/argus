import { and, asc, eq } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { type FalconCloud, falconCloudLabel } from "../alerts/vocabulary";
import { recordOrgAudit } from "../audit/org-audit-log";
import type { FalconCredentials } from "../crowdstrike/falcon";
import type { Tx } from "../db/client";
import { integrations } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";

/**
 * Integrations as Admins manage them: add a CrowdStrike Integration, rotate its credentials, pause
 * and resume it, each recorded in the Organization Audit Log. Every Member sees the Organization's
 * Integrations and how their streams are doing; only Admins see which credentials are in use.
 * The stream itself is the worker's (`crowdstrike/stream-worker.ts`).
 */

export class IntegrationNotFound extends Error {
  constructor() {
    super("No such Integration");
  }
}

export class IntegrationNameTaken extends Error {
  constructor(name: string) {
    super(`An Integration is already called "${name}"`);
  }
}

const isUniqueViolation = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23505";

/** The last four characters of a client id, as shown to Admins: "…a1b2". */
const hintOf = (clientId: string) => `…${clientId.slice(-4)}`;

const actorOf = (me: Membership) => ({ type: "member" as const, id: me.userId, name: me.name });

/** `me`'s Organization's Integration `id`, locked for the change about to be made. */
async function find(tx: Tx, me: Membership, id: string) {
  const [row] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.organizationId, me.organizationId)))
    .for("update")
    .limit(1);
  if (!row) throw new IntegrationNotFound();
  return row;
}

export type NewIntegration = { name: string; cloud: FalconCloud; credentials: FalconCredentials };

export function integrationStore({ db, clock, credentials: sealer }: Pick<Deps, "db" | "clock" | "credentials">) {
  const seal = (c: FalconCredentials) => sealer.seal(JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret }));

  return {
    /** The Organization's Integrations, oldest first. */
    async list(me: Membership) {
      const admin = organizationPolicy.canManageIntegrations(me);
      const rows = await db
        .select()
        .from(integrations)
        .where(eq(integrations.organizationId, me.organizationId))
        .orderBy(asc(integrations.createdAt), asc(integrations.id));
      return rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        cloud: row.cloud,
        paused: row.paused,
        health: row.health,
        healthDetail: row.healthDetail,
        healthChangedAt: row.healthChangedAt.toISOString(),
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        streamOffset: row.streamOffset,
        sessionRefreshAt: row.sessionRefreshAt?.toISOString() ?? null,
        workerId: row.workerId,
        lastGap:
          row.lastGapAt && row.lastGapFromOffset !== null && row.lastGapToOffset !== null
            ? { at: row.lastGapAt.toISOString(), fromOffset: row.lastGapFromOffset, toOffset: row.lastGapToOffset }
            : null,
        /** For Admins only: which credentials are in use, never the credentials themselves. */
        credentials: admin ? { clientIdHint: row.clientIdHint, updatedAt: row.credentialsUpdatedAt.toISOString() } : null,
      }));
    },

    /** Adds a CrowdStrike Integration. A worker picks it up and connects. Admins only. */
    async create(me: Membership, input: NewIntegration) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const now = clock.now();
      const id = secureId();
      const sealed = await seal(input.credentials);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(integrations).values({
            id,
            organizationId: me.organizationId,
            type: "crowdstrike",
            name: input.name,
            cloud: input.cloud,
            credentials: sealed,
            clientIdHint: hintOf(input.credentials.clientId),
            credentialsRevision: 1,
            credentialsUpdatedAt: now,
            health: "connecting",
            healthChangedAt: now,
            createdById: me.userId,
            createdAt: now,
          });
          await recordOrgAudit(tx, {
            organizationId: me.organizationId,
            occurredAt: now,
            actor: actorOf(me),
            category: "integrations",
            action: "integration.created",
            target: input.name,
            after: `CrowdStrike ${falconCloudLabel[input.cloud]} · client ${hintOf(input.credentials.clientId)}`,
          });
          await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new IntegrationNameTaken(input.name);
        throw e;
      }
      return { id, name: input.name };
    },

    /** Replaces the Integration's Falcon API credentials; its worker reconnects with them. Admins only. */
    async rotateCredentials(me: Membership, id: string, credentials: FalconCredentials) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const sealed = await seal(credentials);
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        const now = clock.now();
        await tx
          .update(integrations)
          .set({
            credentials: sealed,
            clientIdHint: hintOf(credentials.clientId),
            credentialsRevision: row.credentialsRevision + 1,
            credentialsUpdatedAt: now,
          })
          .where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: "integration.credentials_rotated",
          target: row.name,
          before: `client ${row.clientIdHint}`,
          after: `client ${hintOf(credentials.clientId)}`,
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },

    /**
     * Pauses the Integration (its worker lets go of the stream, keeping the offset) or resumes it
     * (a worker reconnects from that offset). Admins only. Doing what is already so changes nothing.
     */
    async setPaused(me: Membership, id: string, paused: boolean) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (row.paused === paused) return;
        const now = clock.now();
        await tx
          .update(integrations)
          .set({ paused, ...(paused ? {} : { health: "connecting" as const, healthDetail: null, healthChangedAt: now }) })
          .where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: paused ? "integration.paused" : "integration.resumed",
          target: row.name,
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },
  };
}

export type IntegrationStore = ReturnType<typeof integrationStore>;
