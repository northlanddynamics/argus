import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { type FalconCloud, falconCloudLabel } from "../alerts/vocabulary";
import { recordOrgAudit } from "../audit/org-audit-log";
import { writeBackCounts } from "../crowdstrike/write-back";
import type { Tx } from "../db/client";
import { integrations, responseActions as responseActionsTable } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { type ProviderCredentials, sealCredentials } from "./credentials";
import { type Provider, providerCapabilities, providerLabel } from "./vocabulary";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import { severityLabel } from "../cases/vocabulary";
import { DEFAULT_FALCON_IOC_DEFAULTS, type FalconIocDefaults, FALCON_IOC_PLATFORMS, falconIocPlatformLabel } from "../response-actions/vocabulary";

/**
 * Integrations as Admins manage them: add one, rotate its credentials, pause and resume it, allow or
 * deny write-back to Falcon, turn Response Actions on or off and set what they are sent with, turn
 * Host containment on or off (ADR 0009), each recorded in the Organization
 * Audit Log. What an Integration can do comes from its Provider (`vocabulary.ts`, ADR 0007). Every
 * Member sees the Organization's Integrations and how their streams are doing; only Admins see which
 * credentials are in use.
 * The stream itself is the worker's (`crowdstrike/stream-worker.ts`); so is checking the credentials
 * of a Provider with no stream, such as Mimecast (`mimecast/health.ts`).
 */

/** The Response Actions taken through each Integration, by where they stand, with the latest failure. */
async function responseActionCounts(db: Deps["db"], integrationIds: readonly string[]) {
  const none = { pending: 0, active: 0, failed: 0, lastError: null as string | null };
  const counts = new Map(integrationIds.map((id) => [id, { ...none }]));
  if (!integrationIds.length) return counts;
  const r = responseActionsTable;
  const rows = await db
    .select({
      integrationId: r.integrationId,
      pending: sql<number>`count(*) FILTER (WHERE ${r.state} IN ('pending', 'removing'))::int`,
      // What Argus put in the tool and still holds there.
      active: sql<number>`count(*) FILTER (WHERE ${r.state} = 'active' AND ${r.origin} = 'created')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${r.state} = 'failed')::int`,
      lastError: sql<string | null>`(array_agg(${r.lastError} ORDER BY ${r.stateChangedAt} DESC) FILTER (WHERE ${r.state} = 'failed'))[1]`,
    })
    .from(r)
    .where(inArray(r.integrationId, [...integrationIds]))
    .groupBy(r.integrationId);
  for (const { integrationId, ...row } of rows) counts.set(integrationId, row);
  return counts;
}

export class IntegrationNotFound extends Error {
  constructor() {
    super("No such Integration");
  }
}

/** The Integration's Provider can't do what was asked of it. */
export class NotSupportedByProvider extends Error {
  constructor(provider: Provider, what: string) {
    super(`${providerLabel[provider]} Integrations don't support ${what}`);
  }
}

/** The defaults asked for can't be used, such as no platform at all. */
export class InvalidDefaults extends Error {}

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

/**
 * `writeBack`: whether Argus may write Alert changes back to Falcon (ADR 0002). Off, the Integration
 * only reads: Alerts still arrive and follow changes made in Falcon, but nothing is sent to Falcon.
 * `responseActions`: whether Response Actions may be taken through it (ADR 0007).
 */
export type NewIntegration =
  | {
      provider: "crowdstrike";
      name: string;
      cloud: FalconCloud;
      credentials: ProviderCredentials["crowdstrike"];
      writeBack: boolean;
      responseActions: boolean;
      /** What its Response Actions are sent with; ADR 0007's if left out. */
      responseActionDefaults?: FalconIocDefaults;
    }
  | {
      /** No Alert stream and no write-back: it only takes Response Actions. */
      provider: "mimecast";
      name: string;
      credentials: ProviderCredentials["mimecast"];
      responseActions: boolean;
      /** Only whether its Response Actions start Internal applies. */
      responseActionDefaults?: FalconIocDefaults;
    };

const writeBackLabel = (on: boolean) => (on ? "write-back on" : "read only");
const responseActionsLabel = (on: boolean) => (on ? "Response Actions on" : "Response Actions off");
const hostContainmentLabel = (on: boolean) => (on ? "Host containment on" : "Host containment off");
/**
 * "Severity from the Case · Windows, macOS, Linux · visible to Guests", as the Org Audit Log says it.
 * Only the last applies to a Provider that takes no Falcon IOCs.
 */
export const defaultsLabel = (d: FalconIocDefaults, provider: Provider = "crowdstrike") =>
  provider !== "crowdstrike" ? (d.internal ? "Internal" : "visible to Guests") : [
    d.severity === "case" ? "Severity from the Case" : `Severity ${severityLabel[d.severity]}`,
    d.platforms.length === FALCON_IOC_PLATFORMS.length ? "every platform" : d.platforms.map((p) => falconIocPlatformLabel[p]).join(", "),
    d.internal ? "Internal" : "visible to Guests",
  ].join(" · ");
/** In a fixed order and without repeats, so equal defaults compare equal. */
const normalized = (d: FalconIocDefaults): FalconIocDefaults => ({
  severity: d.severity,
  platforms: FALCON_IOC_PLATFORMS.filter((p) => d.platforms.includes(p)),
  internal: d.internal,
});

export function integrationStore({ db, clock, credentials: sealer }: Pick<Deps, "db" | "clock" | "credentials">) {
  const seal = (provider: Provider, c: ProviderCredentials[Provider]) => sealCredentials(sealer, provider, c);

  return {
    /** The Organization's Integrations, oldest first. */
    async list(me: Membership) {
      const admin = organizationPolicy.canManageIntegrations(me);
      const rows = await db
        .select()
        .from(integrations)
        .where(eq(integrations.organizationId, me.organizationId))
        .orderBy(asc(integrations.createdAt), asc(integrations.id));
      const writeBacks = await writeBackCounts(
        db,
        rows.map((r) => r.id),
        clock.now(),
      );
      const taken = await responseActionCounts(
        db,
        rows.map((r) => r.id),
      );
      return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        /** The Provider, under its older name. */
        type: row.provider,
        /** What its Provider lets it do. */
        capabilities: providerCapabilities[row.provider],
        name: row.name,
        cloud: row.cloud,
        paused: row.paused,
        writeBack: row.writeBack,
        responseActions: row.responseActions,
        /** What a Response Action taken through it is sent with besides its action. */
        responseActionDefaults: row.responseActionDefaults,
        /** Whether Members may contain hosts through it (ADR 0009). */
        hostContainment: row.hostContainment,
        health: row.health,
        healthDetail: row.healthDetail,
        healthChangedAt: row.healthChangedAt.toISOString(),
        /** When its credentials were last checked, for a Provider with no stream. */
        healthCheckedAt: row.healthCheckedAt?.toISOString() ?? null,
        /** Why host Enrichment is unavailable through it (ADR 0009); null while it works. */
        hostEnrichmentError: row.hostEnrichmentError,
        /** Why identity Enrichment is unavailable through it (ADR 0009); null while it works. */
        identityEnrichmentError: row.identityEnrichmentError,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        streamOffset: row.streamOffset,
        sessionRefreshAt: row.sessionRefreshAt?.toISOString() ?? null,
        workerId: row.workerId,
        lastGap:
          row.lastGapAt && row.lastGapFromOffset !== null && row.lastGapToOffset !== null
            ? { at: row.lastGapAt.toISOString(), fromOffset: row.lastGapFromOffset, toOffset: row.lastGapToOffset }
            : null,
        /** Its write-backs to Falcon, by where they stand. */
        writeBacks: writeBacks.get(row.id)!,
        /** The Response Actions taken through it, by where they stand. */
        responseActionCounts: taken.get(row.id)!,
        /** For Admins only: which credentials are in use, never the credentials themselves. */
        credentials: admin ? { clientIdHint: row.clientIdHint, updatedAt: row.credentialsUpdatedAt.toISOString() } : null,
      }));
    },

    /** Adds an Integration. A worker picks it up and connects, if its Provider sends Alerts. Admins only. */
    async create(me: Membership, input: NewIntegration) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const now = clock.now();
      const id = secureId();
      const sealed = await seal(input.provider, input.credentials);
      try {
        await db.transaction(async (tx) => {
          await tx.insert(integrations).values({
            id,
            organizationId: me.organizationId,
            provider: input.provider,
            name: input.name,
            cloud: input.provider === "crowdstrike" ? input.cloud : null,
            credentials: sealed,
            clientIdHint: hintOf(input.credentials.clientId),
            credentialsRevision: 1,
            credentialsUpdatedAt: now,
            writeBack: input.provider === "crowdstrike" && input.writeBack,
            responseActions: input.responseActions,
            responseActionDefaults: normalized(input.responseActionDefaults ?? DEFAULT_FALCON_IOC_DEFAULTS),
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
            after: [
              input.provider === "crowdstrike" ? `${providerLabel[input.provider]} ${falconCloudLabel[input.cloud]}` : providerLabel[input.provider],
              `client ${hintOf(input.credentials.clientId)}`,
              ...(input.provider === "crowdstrike" ? [writeBackLabel(input.writeBack)] : []),
              ...(input.responseActions ? [responseActionsLabel(true)] : []),
            ].join(" · "),
          });
          await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new IntegrationNameTaken(input.name);
        throw e;
      }
      return { id, name: input.name };
    },

    /** Replaces the Integration's API credentials; its worker reconnects with them. Admins only. */
    async rotateCredentials(me: Membership, id: string, credentials: ProviderCredentials[Provider]) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        const sealed = await seal(row.provider, credentials);
        const now = clock.now();
        await tx
          .update(integrations)
          .set({
            credentials: sealed,
            clientIdHint: hintOf(credentials.clientId),
            credentialsRevision: row.credentialsRevision + 1,
            credentialsUpdatedAt: now,
            // With no stream to reconnect, the new credentials are checked afresh (`mimecast/health.ts`).
            ...(!providerCapabilities[row.provider].receivesAlerts && { health: "connecting" as const, healthDetail: null, healthChangedAt: now }),
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

    /**
     * Allows or denies writing Alert changes back to Falcon. Denied, the Integration keeps reading
     * the stream but nothing is written to Falcon. Admins only. Doing what is already so changes nothing.
     */
    async setWriteBack(me: Membership, id: string, writeBack: boolean) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (!providerCapabilities[row.provider].writesBack) throw new NotSupportedByProvider(row.provider, "write-back");
        if (row.writeBack === writeBack) return;
        const now = clock.now();
        await tx.update(integrations).set({ writeBack }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: writeBack ? "integration.write_back_enabled" : "integration.write_back_disabled",
          target: row.name,
          before: writeBackLabel(row.writeBack),
          after: writeBackLabel(writeBack),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },

    /**
     * Turns Response Actions on or off for the Integration. Separate from write-back: a CrowdStrike
     * Integration needs IOC Management write scope for them, not the Alerts write scope. Admins only.
     * Doing what is already so changes nothing.
     */
    async setResponseActions(me: Membership, id: string, responseActions: boolean) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (!providerCapabilities[row.provider].responseActions) throw new NotSupportedByProvider(row.provider, "Response Actions");
        if (row.responseActions === responseActions) return;
        const now = clock.now();
        await tx.update(integrations).set({ responseActions }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: responseActions ? "integration.response_actions_enabled" : "integration.response_actions_disabled",
          target: row.name,
          before: responseActionsLabel(row.responseActions),
          after: responseActionsLabel(responseActions),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },

    /**
     * Turns Host containment on or off for a CrowdStrike Integration (ADR 0009). Independent of
     * Response Actions: its API client needs Hosts: Write for it. Containments already taken are left
     * as they are. Admins only. Doing what is already so changes nothing.
     */
    async setHostContainment(me: Membership, id: string, hostContainment: boolean) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (row.provider !== "crowdstrike") throw new NotSupportedByProvider(row.provider, "Host containment");
        if (row.hostContainment === hostContainment) return;
        const now = clock.now();
        await tx.update(integrations).set({ hostContainment }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: hostContainment ? "integration.host_containment_enabled" : "integration.host_containment_disabled",
          target: row.name,
          before: hostContainmentLabel(row.hostContainment),
          after: hostContainmentLabel(hostContainment),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },

    /**
     * Sets what a Falcon custom IOC taken through the Integration is sent with besides its action:
     * its severity (fixed, or the Case's), its platforms (at least one) and whether it starts
     * Internal. Response Actions already taken keep what they were taken with. Admins only. Doing
     * what is already so changes nothing.
     */
    async setResponseActionDefaults(me: Membership, id: string, defaults: FalconIocDefaults) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const next = normalized(defaults);
      if (!next.platforms.length) throw new InvalidDefaults("Choose at least one platform");
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (!providerCapabilities[row.provider].responseActions) throw new NotSupportedByProvider(row.provider, "Response Actions");
        const before = normalized(row.responseActionDefaults);
        if (JSON.stringify(before) === JSON.stringify(next)) return;
        const now = clock.now();
        await tx.update(integrations).set({ responseActionDefaults: next }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: "integration.response_action_defaults_changed",
          target: row.name,
          before: defaultsLabel(before, row.provider),
          after: defaultsLabel(next, row.provider),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },
  };
}

export type IntegrationStore = ReturnType<typeof integrationStore>;
