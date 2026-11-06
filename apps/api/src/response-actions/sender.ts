import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { caseRoleHolderIds } from "../case-roles/holders";
import { caseRef } from "../cases/vocabulary";
import { IOC_PLATFORMS, type FalconConnector } from "../crowdstrike/falcon";
import { streamConnection } from "../crowdstrike/stream-state";
import type { Tx } from "../db/client";
import { cases, integrations, observables, organization, responseActionOutbox, responseActions } from "../db/schema";
import type { Deps } from "../deps";
import { guestGrantsOf } from "../guests/grants";
import { openCredentials } from "../integrations/credentials";
import { providerCapabilities } from "../integrations/vocabulary";
import type { BlockedSenderType, MimecastConnector } from "../mimecast/mimecast";
import { notify } from "../notifications/notifications";
import type { ObservableType } from "../observables/vocabulary";
import { publish } from "../realtime/signals";
import type { FalconIocType } from "./vocabulary";
import { recordStateChange } from "./response-actions";

/**
 * The worker's half of Response Actions (ADR 0007): sends what the outbox holds, to Falcon as custom
 * IOCs or to Mimecast as Organization-wide Blocked Senders entries, as the Falcon
 * write-back sender does (`crowdstrike/write-back.ts`). Each attempt is claimed with
 * `FOR UPDATE SKIP LOCKED`, so however many workers run, each is made by one. A failure is retried
 * with backoff; when the attempts run out the Response Action is Failed, and the Member who took it
 * is notified. Integrations that are paused, or whose Organization was deleted, are left alone.
 *
 * Before creating anything it looks the value up in the tool: if it is already there, the Response
 * Action is Active and "already present in the tool", and nothing is written.
 *
 * Removing deletes what Argus created, by the id the tool gave it. If the tool says it is already
 * gone, the removal has still succeeded. Once removed, every "already present" record relying on it,
 * on any Case, is Removed too. When removal fails for good, the Member who asked for it is notified.
 */

/** The most attempts made in one transaction. */
export const RESPONSE_ACTION_BATCH = 50;
/** After this many failures a Response Action is Failed. */
export const MAX_RESPONSE_ACTION_ATTEMPTS = 5;
/** How long to wait before retrying an attempt that has failed `attempts` times: 30 s, doubling, at most an hour. */
export const responseActionRetryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 60 * 60_000);

/** Who the Case Audit Log says made a change the worker made. */
const ARGUS = { type: "system" as const, name: "Argus" };

/** `C-12: Phishing at Acme`, and a link to the Case: the IOC's description in Falcon, and the blocked sender's in Mimecast. */
export const iocDescription = (c: { number: number; title: string }, baseUrl: string) =>
  `${caseRef(c.number)}: ${c.title}\n${new URL(`/cases/${c.number}`, baseUrl)}`;

/**
 * A tool as the sender uses it, whatever its Provider: look a Response Action's target up, create it,
 * and delete what was created by the id the tool gave it.
 */
type Tool = {
  holds(r: typeof responseActions.$inferSelect): Promise<boolean>;
  create(r: typeof responseActions.$inferSelect, c: { number: number; title: string }): Promise<string>;
  /** True when the tool deleted it, false when it is already gone. */
  remove(externalId: string): Promise<boolean>;
};

/**
 * `connect` makes Falcon clients and `mimecast` Mimecast ones; a Response Action through a Provider
 * the sender has no connector for fails its attempt.
 */
export function createResponseActionSender(
  { db, clock, credentials, baseUrl }: Pick<Deps, "db" | "clock" | "credentials" | "baseUrl">,
  { connect, mimecast }: { connect?: FalconConnector; mimecast?: MimecastConnector },
) {
  const falconTool = async (integrationId: string) => {
    const found = await streamConnection(db, credentials, integrationId);
    if (!found) return null;
    if (!connect) throw new Error("This worker can't reach Falcon");
    const client = connect(found.connection);
    const tool: Tool = {
      holds: async (r) => !!(await client.findIoc(r.targetType as FalconIocType, r.targetValue)),
      create: (r, c) =>
        client.createIoc({
          type: r.targetType as FalconIocType,
          value: r.targetValue,
          action: r.falconAction!,
          severity: r.severity!,
          platforms: r.falconPlatforms ?? IOC_PLATFORMS,
          appliedGlobally: true,
          source: "Argus",
          description: iocDescription(c, baseUrl),
        }),
      remove: (id) => client.deleteIoc(id),
    };
    return { revision: found.credentialsRevision, tool };
  };

  const mimecastTool = async (row: typeof integrations.$inferSelect) => {
    if (!mimecast) throw new Error("This worker can't reach Mimecast");
    const client = mimecast(await openCredentials(credentials, "mimecast", row.credentials));
    const tool: Tool = {
      holds: async (r) => !!(await client.findBlockedSender(r.targetType as BlockedSenderType, r.targetValue)),
      create: (r, c) =>
        client.blockSender({ type: r.targetType as BlockedSenderType, value: r.targetValue, appliesTo: "everyone", description: iocDescription(c, baseUrl) }),
      remove: (id) => client.deleteBlockedSender(id),
    };
    return { revision: row.credentialsRevision, tool };
  };

  /** One client per Integration, until its credentials are rotated. */
  const clients = new Map<string, { revision: number; tool: Tool }>();
  const clientFor = async (integrationId: string) => {
    const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
    if (!row) return null;
    const cached = clients.get(integrationId);
    if (cached?.revision === row.credentialsRevision) return cached.tool;
    const made = row.provider === "mimecast" ? await mimecastTool(row) : await falconTool(integrationId);
    if (!made) return null;
    clients.set(integrationId, made);
    return made.tool;
  };

  /** Response Action `r` failed for good: it is Failed, and whoever took it (or asked to remove it) hears so. */
  const giveUp = async (tx: Tx, due: Due, message: string, now: Date) => {
    const removing = due.attempt.operation === "remove";
    await tx
      .update(responseActionOutbox)
      .set({ state: "failed", attempts: due.attempt.attempts + 1, lastError: message, finishedAt: now })
      .where(eq(responseActionOutbox.id, due.attempt.id));
    const [failed] = await tx
      .update(responseActions)
      .set({ state: "failed", stateChangedAt: now, lastError: message })
      .where(eq(responseActions.id, due.r.id))
      .returning();
    await recordStateChange(tx, { r: failed!, observable: due.observable, change: removing ? "removal_failed" : "failed", actor: ARGUS, now, detail: message });
    const theCase = {
      id: due.r.caseId,
      organizationId: due.r.organizationId,
      restricted: due.case.restricted,
      assigneeId: due.case.assigneeId,
      caseRoleHolderIds: await caseRoleHolderIds(tx, due.r.caseId),
      guests: await guestGrantsOf(tx, due.r.caseId),
    };
    const notice = removing
      ? { recipientId: due.r.removalRequestedById ?? due.r.createdById, kind: "response_action_removal_failed" as const, actorId: null }
      : { recipientId: due.r.createdById, kind: "response_action_failed" as const, actorId: null };
    await notify(tx, theCase, [notice], now, failed!);
  };

  /**
   * Response Action `due.r` is gone from the tool: it is Removed, and so is every Active "already
   * present" record relying on it, each on its own Case.
   */
  const removed = async (tx: Tx, due: Due, deleted: boolean, now: Date) => {
    await tx
      .update(responseActionOutbox)
      .set({ state: "done", attempts: due.attempt.attempts + 1, lastError: null, finishedAt: now })
      .where(eq(responseActionOutbox.id, due.attempt.id));
    const [gone] = await tx
      .update(responseActions)
      .set({ state: "removed", stateChangedAt: now, lastError: null })
      .where(eq(responseActions.id, due.r.id))
      .returning();
    await recordStateChange(tx, { r: gone!, observable: due.observable, change: deleted ? "removed" : "already_gone", actor: ARGUS, now });
    const relying = await tx
      .update(responseActions)
      .set({ state: "removed", stateChangedAt: now })
      .where(and(eq(responseActions.presentFromId, due.r.id), eq(responseActions.state, "active"), eq(responseActions.origin, "already_present")))
      .returning();
    for (const r of relying) {
      await recordStateChange(tx, { r, observable: due.observable, change: "relied_on_removed", actor: ARGUS, now });
    }
  };

  type Due = {
    attempt: typeof responseActionOutbox.$inferSelect;
    r: typeof responseActions.$inferSelect;
    observable: { type: ObservableType; value: string };
    case: { number: number; title: string; restricted: boolean; assigneeId: string | null };
    responseActionsOn: boolean;
    provider: keyof typeof providerCapabilities;
  };

  /** Makes one batch of attempts; returns how many it finished or rescheduled. */
  const sendBatch = async () =>
    db.transaction(async (tx) => {
      const now = clock.now();
      const o = responseActionOutbox;
      const rows = await tx
        .select({
          attempt: o,
          r: responseActions,
          observableType: observables.type,
          observableValue: observables.value,
          caseNumber: cases.number,
          caseTitle: cases.title,
          caseRestricted: cases.restricted,
          caseAssigneeId: cases.assigneeId,
          responseActionsOn: integrations.responseActions,
          provider: integrations.provider,
        })
        .from(o)
        .innerJoin(responseActions, eq(o.responseActionId, responseActions.id))
        .innerJoin(observables, eq(responseActions.observableId, observables.id))
        .innerJoin(cases, eq(responseActions.caseId, cases.id))
        .innerJoin(integrations, eq(responseActions.integrationId, integrations.id))
        .innerJoin(organization, eq(o.organizationId, organization.id))
        .where(and(eq(o.state, "pending"), lte(o.nextAttemptAt, now), eq(integrations.paused, false), isNull(organization.deletedAt)))
        .orderBy(asc(o.seq))
        .limit(RESPONSE_ACTION_BATCH)
        .for("update", { of: [o, responseActions], skipLocked: true });
      if (!rows.length) return 0;

      for (const row of rows) {
        const due: Due = {
          attempt: row.attempt,
          r: row.r,
          observable: { type: row.observableType as ObservableType, value: row.observableValue },
          case: { number: row.caseNumber, title: row.caseTitle, restricted: row.caseRestricted, assigneeId: row.caseAssigneeId },
          responseActionsOn: row.responseActionsOn,
          provider: row.provider,
        };
        const removing = due.attempt.operation === "remove";
        if (!due.responseActionsOn || !providerCapabilities[due.provider].responseActions) {
          await giveUp(tx, due, `Response Actions were turned off for the Integration before this was ${removing ? "removed" : "sent"}`, now);
          continue;
        }
        try {
          const client = await clientFor(due.r.integrationId);
          if (!client) {
            await giveUp(tx, due, "The Integration no longer exists", now);
            continue;
          }
          if (removing) {
            // Only ever what Argus created, by the id the tool gave it.
            await removed(tx, due, due.r.externalId ? await client.remove(due.r.externalId) : false, now);
            continue;
          }
          // Never overwrite what is already there: if the tool holds it, nothing is written.
          if (await client.holds(due.r)) {
            await tx
              .update(o)
              .set({ state: "done", attempts: due.attempt.attempts + 1, lastError: null, finishedAt: now })
              .where(eq(o.id, due.attempt.id));
            const [present] = await tx
              .update(responseActions)
              .set({ state: "active", origin: "in_tool", stateChangedAt: now, lastError: null })
              .where(eq(responseActions.id, due.r.id))
              .returning();
            await recordStateChange(tx, { r: present!, observable: due.observable, change: "in_tool", actor: ARGUS, now });
            continue;
          }
          const externalId = await client.create(due.r, due.case);
          await tx
            .update(o)
            .set({ state: "done", attempts: due.attempt.attempts + 1, lastError: null, finishedAt: now })
            .where(eq(o.id, due.attempt.id));
          const [sent] = await tx
            .update(responseActions)
            .set({ state: "active", externalId, sentAt: now, stateChangedAt: now, lastError: null })
            .where(eq(responseActions.id, due.r.id))
            .returning();
          await recordStateChange(tx, { r: sent!, observable: due.observable, change: "sent", actor: ARGUS, now });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const attempts = due.attempt.attempts + 1;
          if (attempts >= MAX_RESPONSE_ACTION_ATTEMPTS) {
            await giveUp(tx, due, message, now);
            continue;
          }
          await tx
            .update(o)
            .set({ attempts, lastError: message, nextAttemptAt: new Date(now.getTime() + responseActionRetryDelayMs(attempts)) })
            .where(eq(o.id, due.attempt.id));
          await tx.update(responseActions).set({ lastError: message }).where(eq(responseActions.id, due.r.id));
          // Members see that it is being retried, and why.
          await publish(tx, { kind: "case", organizationId: due.r.organizationId, caseId: due.r.caseId, membersOnly: true });
        }
      }
      return rows.length;
    });

  let running: Promise<void> | null = null;
  return {
    /** Makes every attempt that is due, batch by batch. A tick while one is running waits for that one. */
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

export type ResponseActionSender = ReturnType<typeof createResponseActionSender>;
