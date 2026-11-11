import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { NotPermitted, organizationPolicy } from "../access/policy";
import { type FalconCloud, falconCloudLabel } from "../alerts/vocabulary";
import { recordOrgAudit } from "../audit/org-audit-log";
import { writeBackCounts } from "../crowdstrike/write-back";
import type { Tx } from "../db/client";
import { falconWorkflows, integrations, responseActions as responseActionsTable } from "../db/schema";
import type { Deps } from "../deps";
import { secureId } from "../ids";
import { openCredentials, type ProviderCredentials, sealCredentials } from "./credentials";
import { type Provider, providerCapabilities, providerLabel } from "./vocabulary";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import { SEVERITIES, type Severity, severityLabel } from "../cases/vocabulary";
import {
  type ChosenDestinationList,
  DEFAULT_FALCON_IOC_DEFAULTS,
  type FalconIocDefaults,
  FALCON_IOC_PLATFORMS,
  falconIocPlatformLabel,
} from "../response-actions/vocabulary";
import { type DestinationList, destinationListAccessLabel } from "../umbrella/umbrella";

/**
 * Integrations as Admins manage them: add one, rotate its credentials, pause and resume it, allow or
 * deny write-back to Falcon, turn Response Actions on or off and set what they are sent with, turn
 * Host containment on or off (ADR 0009), choose the Severities of detections it ignores, delete it (ADR 0013), each recorded in the Organization
 * Audit Log. What an Integration can do comes from its Provider (`vocabulary.ts`, ADR 0007). Every
 * Member sees the Organization's Integrations and how their streams are doing; only Admins see which
 * credentials are in use.
 * The stream itself is the worker's (`crowdstrike/stream-worker.ts`); so is checking the credentials
 * of a Provider with no stream, such as Mimecast (`mimecast/health.ts`) or Cisco Umbrella
 * (`umbrella/health.ts`). Choosing a Cisco Umbrella Integration's destination list (ADR 0014) asks
 * Umbrella for its lists while the Admin waits.
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

/** Ignoring every Severity would receive no Alerts at all: pausing the Integration does that. */
export class IgnoresEverySeverity extends Error {
  constructor() {
    super("Leave at least one Severity unignored; to stop receiving Alerts, pause the Integration");
  }
}

/**
 * Response Actions taken through the Integration may still be held in its tool, so it can't be deleted
 * until they are removed from their Cases: nothing could remove them afterwards (ADR 0013).
 */
export class IntegrationHoldsResponseActions extends Error {
  constructor(count: number) {
    super(
      count === 1
        ? "1 Response Action taken through this Integration is still in place; remove it from its Case first"
        : `${count} Response Actions taken through this Integration are still in place; remove them from their Cases first`,
    );
  }
}

export class IntegrationNameTaken extends Error {
  constructor(name: string) {
    super(`An Integration is already called "${name}"`);
  }
}

/** The Organization already has an IPinfo Integration: IPs are looked up through one (ADR 0010). */
export class OneIpinfoIntegration extends Error {
  constructor() {
    super("Your Organization already has an IPinfo Integration; rotate its token instead");
  }
}

/** The credentials given aren't the kind the Integration's Provider takes. */
export class WrongCredentials extends Error {
  constructor(provider: Provider) {
    super(
      provider === "ipinfo"
        ? "IPinfo takes an API token"
        : provider === "umbrella"
          ? "Cisco Umbrella takes an API key and secret"
          : `${providerLabel[provider]} takes a client ID and secret`,
    );
  }
}

/** Umbrella holds no destination list with the id asked for. */
export class UnknownDestinationList extends Error {
  constructor() {
    super("Umbrella has no destination list with that id");
  }
}

/** Umbrella couldn't be asked for the Integration's destination lists; the message says why. */
export class ToolUnavailable extends Error {}

const uniqueViolationOf = (e: unknown) => {
  const cause = (e as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" ? (cause.constraint_name ?? "") : null;
};

/** The last four characters of a client id, or of an API token, as shown to Admins: "…a1b2". */
const hintOf = (clientId: string) => `…${clientId.slice(-4)}`;

/** What identifies the credentials to Admins: the client id's last four, or the token's. */
const credentialsHint = (c: ProviderCredentials[Provider]) => hintOf("token" in c ? c.token : c.clientId);
/** "client …a1b2" or "token …a1b2", as the Org Audit Log says it. */
const credentialsLabel = (provider: Provider, hint: string) => `${provider === "ipinfo" ? "token" : provider === "umbrella" ? "key" : "client"} ${hint}`;
/** Whether `c` is the kind of credentials `provider` takes. */
const fits = (provider: Provider, c: ProviderCredentials[Provider]) => (provider === "ipinfo") === "token" in c;

const actorOf = (me: Membership) => ({ type: "member" as const, id: me.userId, name: me.name });

/** `me`'s Organization's Integration `id`, unless deleted, locked for the change about to be made. */
async function find(tx: Tx, me: Membership, id: string) {
  const [row] = await tx
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.organizationId, me.organizationId), isNull(integrations.deletedAt)))
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
    }
  | {
      /**
       * No Alert stream and no write-back (ADR 0014): it checks domains against its destination lists,
       * and adds them to the one an Admin chooses once it is added.
       */
      provider: "umbrella";
      name: string;
      credentials: ProviderCredentials["umbrella"];
      responseActions: boolean;
      /** Only whether its Response Actions start Internal applies. */
      responseActionDefaults?: FalconIocDefaults;
    }
  | {
      /** Only looks IPs up (ADR 0010): no Alerts, write-back or Response Actions. One per Organization. */
      provider: "ipinfo";
      name: string;
      credentials: ProviderCredentials["ipinfo"];
    };

const writeBackLabel = (on: boolean) => (on ? "write-back on" : "read only");
const responseActionsLabel = (on: boolean) => (on ? "Response Actions on" : "Response Actions off");
const hostContainmentLabel = (on: boolean) => (on ? "Host containment on" : "Host containment off");
const workflowsLabel = (on: boolean) => (on ? "Workflows on" : "Workflows off");
/** "Phishing domains (Block, 1234)", as the Org Audit Log names a destination list. */
const destinationListLabel = (l: ChosenDestinationList | null) => (l ? `${l.name} (${destinationListAccessLabel[l.access]}, ${l.id})` : "none");
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
/** The ignored Severities in Severity order, without repeats, so equal choices compare equal. */
const orderedSeverities = (severities: readonly Severity[]) => SEVERITIES.filter((s) => severities.includes(s));
/** "Ignoring Low, Informational" or "Ignoring none", as the Org Audit Log says it. */
const ignoredSeveritiesLabel = (severities: readonly Severity[]) =>
  `Ignoring ${severities.length ? orderedSeverities(severities).map((s) => severityLabel[s]).join(", ") : "none"}`;
/** In a fixed order and without repeats, so equal defaults compare equal. */
const normalized = (d: FalconIocDefaults): FalconIocDefaults => ({
  severity: d.severity,
  platforms: FALCON_IOC_PLATFORMS.filter((p) => d.platforms.includes(p)),
  internal: d.internal,
});

export function integrationStore({ db, clock, credentials: sealer, umbrella }: Pick<Deps, "db" | "clock" | "credentials" | "umbrella">) {
  const seal = (provider: Provider, c: ProviderCredentials[Provider]) => sealCredentials(sealer, provider, c);

  /** Umbrella Integration `id` of `me`'s Organization, unless deleted, with a client for it. */
  const umbrellaOf = async (me: Membership, id: string) => {
    const [row] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.organizationId, me.organizationId), isNull(integrations.deletedAt)))
      .limit(1);
    if (!row) throw new IntegrationNotFound();
    if (row.provider !== "umbrella") throw new NotSupportedByProvider(row.provider, "destination lists");
    return umbrella(await openCredentials(sealer, "umbrella", row.credentials));
  };

  /** Umbrella's destination lists, through `client`; `ToolUnavailable` when it can't be asked. */
  const listsFrom = async (client: Awaited<ReturnType<typeof umbrellaOf>>): Promise<DestinationList[]> => {
    try {
      return await client.destinationLists();
    } catch (e) {
      throw new ToolUnavailable(e instanceof Error ? e.message : String(e));
    }
  };

  return {
    /** The Organization's Integrations, oldest first; deleted ones are left out. */
    async list(me: Membership) {
      const admin = organizationPolicy.canManageIntegrations(me);
      const rows = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, me.organizationId), isNull(integrations.deletedAt)))
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
      const discovered = new Map<string, number>();
      if (rows.length) {
        const counted = await db
          .select({ integrationId: falconWorkflows.integrationId, count: sql<number>`count(*)::int` })
          .from(falconWorkflows)
          .where(and(inArray(falconWorkflows.integrationId, rows.map((r) => r.id)), isNull(falconWorkflows.removedAt)))
          .groupBy(falconWorkflows.integrationId);
        for (const c of counted) discovered.set(c.integrationId, c.count);
      }
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
        /** The Umbrella destination list it adds domains to (ADR 0014); null until an Admin chooses one. */
        destinationList: row.destinationList,
        /** The Severities of detections it receives no Alert for, in Severity order; none for a Provider that sends no Alerts. */
        ignoredSeverities: orderedSeverities(row.ignoredSeverities),
        health: row.health,
        healthDetail: row.healthDetail,
        healthChangedAt: row.healthChangedAt.toISOString(),
        /** When its credentials were last checked, for a Provider with no stream. */
        healthCheckedAt: row.healthCheckedAt?.toISOString() ?? null,
        /** Why host Enrichment is unavailable through it (ADR 0009); null while it works. */
        hostEnrichmentError: row.hostEnrichmentError,
        /** Why identity Enrichment is unavailable through it (ADR 0009); null while it works. */
        identityEnrichmentError: row.identityEnrichmentError,
        /** Whether Members may run its Falcon Fusion SOAR Workflows (ADR 0017). */
        workflows: row.workflows,
        /** Its Workflows as last discovered: how many Falcon lists, when, and why that failed if it did. */
        workflowDiscovery:
          row.provider === "crowdstrike"
            ? { count: discovered.get(row.id) ?? 0, checkedAt: row.workflowsCheckedAt?.toISOString() ?? null, refreshing: row.workflowsDue, error: row.workflowsError }
            : null,
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
            clientIdHint: credentialsHint(input.credentials),
            credentialsRevision: 1,
            credentialsUpdatedAt: now,
            writeBack: input.provider === "crowdstrike" && input.writeBack,
            responseActions: input.provider !== "ipinfo" && input.responseActions,
            responseActionDefaults: normalized((input.provider !== "ipinfo" && input.responseActionDefaults) || DEFAULT_FALCON_IOC_DEFAULTS),
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
              credentialsLabel(input.provider, credentialsHint(input.credentials)),
              ...(input.provider === "crowdstrike" ? [writeBackLabel(input.writeBack)] : []),
              ...(input.provider !== "ipinfo" && input.responseActions ? [responseActionsLabel(true)] : []),
            ].join(" · "),
          });
          await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        });
      } catch (e) {
        const violated = uniqueViolationOf(e);
        if (violated === "integrations_one_ipinfo_idx") throw new OneIpinfoIntegration();
        if (violated !== null) throw new IntegrationNameTaken(input.name);
        throw e;
      }
      return { id, name: input.name };
    },

    /** Replaces the Integration's API credentials; its worker reconnects with them. Admins only. */
    async rotateCredentials(me: Membership, id: string, credentials: ProviderCredentials[Provider]) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (!fits(row.provider, credentials)) throw new WrongCredentials(row.provider);
        const sealed = await seal(row.provider, credentials);
        const now = clock.now();
        await tx
          .update(integrations)
          .set({
            credentials: sealed,
            clientIdHint: credentialsHint(credentials),
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
          before: credentialsLabel(row.provider, row.clientIdHint),
          after: credentialsLabel(row.provider, credentialsHint(credentials)),
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
     * Turns Workflows on or off for a CrowdStrike Integration (ADR 0017): on, Members may run its
     * discovered Falcon Fusion SOAR Workflows. Discovery happens either way. Runs already sent are
     * still watched; queued ones fail. Its API client needs Workflow: Write. Admins only. Doing what
     * is already so changes nothing.
     */
    async setWorkflows(me: Membership, id: string, workflows: boolean) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (row.provider !== "crowdstrike") throw new NotSupportedByProvider(row.provider, "Workflows");
        if (row.workflows === workflows) return;
        const now = clock.now();
        await tx.update(integrations).set({ workflows }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: workflows ? "integration.workflows_enabled" : "integration.workflows_disabled",
          target: row.name,
          before: workflowsLabel(row.workflows),
          after: workflowsLabel(workflows),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
        await publish(tx, { kind: "actions", organizationId: me.organizationId });
      });
    },

    /**
     * The destination lists of Cisco Umbrella Integration `id`, as Umbrella holds them now, for an
     * Admin choosing the one it adds domains to (ADR 0014). Throws `ToolUnavailable` when Umbrella
     * can't be asked. Admins only.
     */
    async destinationLists(me: Membership, id: string) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const lists = await listsFrom(await umbrellaOf(me, id));
      return lists.toSorted((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    },

    /**
     * Chooses the destination list Cisco Umbrella Integration `id` adds domains to as Response Actions
     * (ADR 0014), checked against Umbrella and recorded as it describes it. Response Actions already
     * taken keep the list they were taken with. Throws `UnknownDestinationList` when Umbrella holds no
     * such list, `ToolUnavailable` when it can't be asked. Admins only. Choosing the list already
     * chosen changes nothing, but refreshes its name.
     */
    async setDestinationList(me: Membership, id: string, listId: number) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const found = (await listsFrom(await umbrellaOf(me, id))).find((l) => l.id === listId);
      if (!found) throw new UnknownDestinationList();
      const next: ChosenDestinationList = { id: found.id, name: found.name, access: found.access };
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (JSON.stringify(row.destinationList) === JSON.stringify(next)) return;
        const now = clock.now();
        await tx.update(integrations).set({ destinationList: next }).where(eq(integrations.id, id));
        // A new name for the same list is not a change an Admin made.
        if (row.destinationList?.id !== next.id) {
          await recordOrgAudit(tx, {
            organizationId: me.organizationId,
            occurredAt: now,
            actor: actorOf(me),
            category: "integrations",
            action: "integration.destination_list_changed",
            target: row.name,
            before: destinationListLabel(row.destinationList),
            after: destinationListLabel(next),
          });
        }
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
      return next;
    },

    /**
     * Sets the Severities of detections the Integration's stream skips: from now on, a detection of
     * one of them becomes no Alert, and an Alert already received is left as it was. Alerts already
     * received stay. Only for a Provider that sends Alerts, and not every Severity: pausing the
     * Integration is how to stop receiving Alerts. Admins only. Doing what is already so changes nothing.
     */
    async setIgnoredSeverities(me: Membership, id: string, severities: readonly Severity[]) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      const next = orderedSeverities(severities);
      if (next.length === SEVERITIES.length) throw new IgnoresEverySeverity();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        if (!providerCapabilities[row.provider].receivesAlerts) throw new NotSupportedByProvider(row.provider, "ignoring Severities");
        const before = orderedSeverities(row.ignoredSeverities);
        if (before.join() === next.join()) return;
        const now = clock.now();
        await tx.update(integrations).set({ ignoredSeverities: next }).where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: "integration.ignored_severities_changed",
          target: row.name,
          before: ignoredSeveritiesLabel(before),
          after: ignoredSeveritiesLabel(next),
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

    /**
     * Deletes the Integration (ADR 0013): it is turned off for good (paused, write-back, Response
     * Actions and Host containment off), leaves Settings and frees its name, but is kept, so the
     * Alerts, Response Actions and lookups made through it still say where they came from. Refused
     * while Response Actions taken through it may still be held in its tool. Admins only.
     */
    async delete(me: Membership, id: string) {
      if (!organizationPolicy.canManageIntegrations(me)) throw new NotPermitted();
      await db.transaction(async (tx) => {
        const row = await find(tx, me, id);
        const r = responseActionsTable;
        const [held] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(r)
          .where(
            and(
              eq(r.integrationId, id),
              // What `response_actions_one_created_idx` counts as held in the tool.
              sql`${r.kind} <> 'falcon_containment_lift' AND ${r.origin} = 'created' AND (${r.state} IN ('pending', 'active', 'removing') OR (${r.state} = 'failed' AND ${r.removalRequestedAt} IS NOT NULL))`,
            ),
          );
        if (held!.count > 0) throw new IntegrationHoldsResponseActions(held!.count);
        const now = clock.now();
        await tx
          .update(integrations)
          .set({ deletedAt: now, deletedById: me.userId, paused: true, writeBack: false, responseActions: false, hostContainment: false, workflows: false })
          .where(eq(integrations.id, id));
        await recordOrgAudit(tx, {
          organizationId: me.organizationId,
          occurredAt: now,
          actor: actorOf(me),
          category: "integrations",
          action: "integration.deleted",
          target: row.name,
          before: [
            row.provider === "crowdstrike" && row.cloud ? `${providerLabel[row.provider]} ${falconCloudLabel[row.cloud]}` : providerLabel[row.provider],
            credentialsLabel(row.provider, row.clientIdHint),
          ].join(" · "),
        });
        await publish(tx, { kind: "alerts", organizationId: me.organizationId });
      });
    },
  };
}

export type IntegrationStore = ReturnType<typeof integrationStore>;
