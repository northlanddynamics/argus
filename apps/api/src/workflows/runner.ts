import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or } from "drizzle-orm";
import { caseRoleHolderIds } from "../case-roles/holders";
import { type FalconClient, type FalconConnector, FalconScopeMissing, type FalconWorkflow, type FalconWorkflowExecution } from "../crowdstrike/falcon";
import { streamConnection } from "../crowdstrike/stream-state";
import type { Tx } from "../db/client";
import { cases, falconWorkflows, integrations, organization, workflowRuns } from "../db/schema";
import type { Deps } from "../deps";
import { guestGrantsOf } from "../guests/grants";
import { secureId } from "../ids";
import { notify } from "../notifications/notifications";
import { publish } from "../realtime/signals";
import { WORKFLOW_OUTPUT_MAX_BYTES, WORKFLOW_RUN_WATCH_MS, type WorkflowRunState, workflowRunStateLabel } from "./vocabulary";
import { announceRun, recordRunAudit, workflowStatus } from "./workflows";

/**
 * The worker's half of Workflows (ADR 0017), on every tick:
 *
 * - **Discovery.** Each CrowdStrike Integration's Falcon Fusion SOAR workflow definitions are listed
 *   every `WORKFLOW_DISCOVERY_INTERVAL_MS`, or sooner when a Member asks (`workflows_due`), and
 *   recorded in `falcon_workflows`. One Falcon no longer lists is kept, marked removed. Discovery
 *   only reads, so it needs no Admin setting; when it fails, as for want of Workflow: Read, the
 *   Integration says why (`workflows_error`) and what was discovered before stays.
 * - **Sending.** A queued Workflow Run is sent to Falcon once. Running a Workflow isn't idempotent,
 *   so a failure is never retried by the worker: the run is Failed, with why, and a Member may Retry
 *   it.
 * - **Watching.** A running Workflow Run's execution is read from Falcon, soon after it is sent and
 *   then less and less often (`workflowCheckDelayMs`), until Falcon reports it completed, failed or
 *   cancelled, recording each step as Falcon reports it and what it returned. A failed read is tried
 *   again at the next check. After `WORKFLOW_RUN_WATCH_MS` without an outcome, Argus stops watching it.
 *
 * Each claim is made with `FOR UPDATE SKIP LOCKED`, so however many workers run, each discovery,
 * send and check is made by one. Integrations that are paused, or whose Organization was deleted,
 * are left alone. A run for a Case that fails notifies the Member who ran it.
 */

/** How often each Integration's Workflows are discovered, unless a Member asks sooner. */
export const WORKFLOW_DISCOVERY_INTERVAL_MS = 15 * 60_000;
/** The most Integrations discovered, or runs sent or checked, in one batch. */
export const WORKFLOW_BATCH = 50;
/** How long to wait before the next read of a running execution that has been read `checks` times: 5 s, doubling, at most 5 minutes. */
export const workflowCheckDelayMs = (checks: number) => Math.min(5_000 * 2 ** checks, 5 * 60_000);

/** What an Integration says while its API client lacks Workflow: Read. */
export const WORKFLOWS_UNAVAILABLE = "Workflows can't be discovered: the API client lacks the Workflow: Read scope";

/** Who the Audit Logs say made a change the worker made. */
const ARGUS = { type: "system" as const, name: "Argus" };

/** `output` as Argus keeps it: as Falcon gave it, unless that is larger than `WORKFLOW_OUTPUT_MAX_BYTES`. */
export function keptOutput(output: unknown) {
  if (output === null || output === undefined) return null;
  const json = JSON.stringify(output);
  if (new TextEncoder().encode(json).length <= WORKFLOW_OUTPUT_MAX_BYTES) return output;
  return { truncated: true, note: `Falcon returned more than ${WORKFLOW_OUTPUT_MAX_BYTES / 1024} KB; see the execution in Falcon`, start: json.slice(0, 4096) };
}

/** Why discovery failed: for want of Workflow: Read, said the same way whatever Falcon said. */
const discoveryFailure = (e: unknown) => (e instanceof FalconScopeMissing ? WORKFLOWS_UNAVAILABLE : e instanceof Error ? e.message : String(e));

/**
 * Run `r` ended: Failed, Completed, Cancelled or with no outcome, as `state` says. Recorded in its
 * Audit Log; a run for a Case that failed (or got no outcome) notifies whoever ran it.
 */
async function finish(tx: Tx, r: typeof workflowRuns.$inferSelect, workflowName: string, state: WorkflowRunState, set: Partial<typeof workflowRuns.$inferInsert>, now: Date) {
  const [done] = await tx
    .update(workflowRuns)
    .set({ ...set, state, finishedAt: set.finishedAt ?? now, nextCheckAt: null, stateChangedAt: now })
    .where(eq(workflowRuns.id, r.id))
    .returning();
  const error = done!.lastError;
  await recordRunAudit(tx, done!, {
    action: "workflow_run.finished",
    actor: ARGUS,
    workflowName,
    after: `${workflowRunStateLabel[state]}${error && state !== "completed" ? `: ${error}` : ""}`,
    now,
  });
  await announceRun(tx, done!);
  if (!done!.caseId || (state !== "failed" && state !== "timed_out")) return;
  const [c] = await tx.select({ restricted: cases.restricted, assigneeId: cases.assigneeId }).from(cases).where(eq(cases.id, done!.caseId));
  if (!c) return;
  const theCase = {
    id: done!.caseId,
    organizationId: done!.organizationId,
    restricted: c.restricted,
    assigneeId: c.assigneeId,
    caseRoleHolderIds: await caseRoleHolderIds(tx, done!.caseId),
    guests: await guestGrantsOf(tx, done!.caseId),
  };
  await notify(tx, theCase, [{ recipientId: done!.createdById, kind: "workflow_run_failed", actorId: null }], now);
}

/** The runs in `state` that are due, through Integrations that aren't paused, locked for this batch. */
const dueRuns = (tx: Tx, state: "pending" | "running", now: Date) =>
  tx
    .select({ r: workflowRuns, w: falconWorkflows, integration: { workflows: integrations.workflows, paused: integrations.paused } })
    .from(workflowRuns)
    .innerJoin(falconWorkflows, eq(workflowRuns.workflowId, falconWorkflows.id))
    .innerJoin(integrations, eq(workflowRuns.integrationId, integrations.id))
    .innerJoin(organization, eq(workflowRuns.organizationId, organization.id))
    .where(and(eq(workflowRuns.state, state), lte(workflowRuns.nextCheckAt, now), eq(integrations.paused, false), isNull(organization.deletedAt)))
    .orderBy(asc(workflowRuns.nextCheckAt), asc(workflowRuns.seq))
    .limit(WORKFLOW_BATCH)
    .for("update", { of: workflowRuns, skipLocked: true });

export function createWorkflowRunner({ db, clock, credentials }: Pick<Deps, "db" | "clock" | "credentials">, { connect }: { connect: FalconConnector }) {
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

  /** Records what one discovery through Integration `i` found, or why it failed. */
  const storeDiscovered = async (i: { id: string; organizationId: string }, found: FalconWorkflow[] | { error: string }) => {
    const now = clock.now();
    await db.transaction(async (tx) => {
      if ("error" in found) {
        await tx.update(integrations).set({ workflowsError: found.error }).where(eq(integrations.id, i.id));
      } else {
        const w = falconWorkflows;
        for (const d of found) {
          const fields = { name: d.name, description: d.description, enabled: d.enabled, onDemand: d.onDemand, inputs: d.inputs, lastSeenAt: now, removedAt: null };
          await tx
            .insert(w)
            .values({ id: secureId(), organizationId: i.organizationId, integrationId: i.id, definitionId: d.id, discoveredAt: now, ...fields })
            .onConflictDoUpdate({ target: [w.integrationId, w.definitionId], set: fields });
        }
        await tx
          .update(w)
          .set({ removedAt: now })
          .where(
            and(
              eq(w.integrationId, i.id),
              isNull(w.removedAt),
              found.length ? notInArray(w.definitionId, found.map((d) => d.id)) : undefined,
            ),
          );
        await tx.update(integrations).set({ workflowsError: null }).where(eq(integrations.id, i.id));
      }
      await publish(tx, { kind: "actions", organizationId: i.organizationId });
      // Settings · Integrations shows how discovery is doing.
      await publish(tx, { kind: "alerts", organizationId: i.organizationId });
    });
  };

  /** Claims the Integrations whose Workflows are due to be discovered, marking them checked now. */
  const claimDiscoveries = () =>
    db.transaction(async (tx) => {
      const now = clock.now();
      const i = integrations;
      const due = await tx
        .select({ id: i.id, organizationId: i.organizationId })
        .from(i)
        .innerJoin(organization, eq(i.organizationId, organization.id))
        .where(
          and(
            eq(i.provider, "crowdstrike"),
            eq(i.paused, false),
            isNull(i.deletedAt),
            isNull(organization.deletedAt),
            or(eq(i.workflowsDue, true), isNull(i.workflowsCheckedAt), lt(i.workflowsCheckedAt, new Date(now.getTime() - WORKFLOW_DISCOVERY_INTERVAL_MS))),
          ),
        )
        .orderBy(asc(i.id))
        .limit(WORKFLOW_BATCH)
        .for("update", { of: i, skipLocked: true });
      if (due.length) {
        await tx
          .update(i)
          .set({ workflowsDue: false, workflowsCheckedAt: now })
          .where(inArray(i.id, due.map((d) => d.id)));
      }
      return due;
    });

  const discover = async () => {
    for (const i of await claimDiscoveries()) {
      let found: FalconWorkflow[] | { error: string };
      try {
        const client = await clientFor(i.id);
        found = client ? await client.workflows() : { error: "The Integration no longer exists" };
      } catch (e) {
        found = { error: discoveryFailure(e) };
      }
      await storeDiscovered(i, found);
    }
  };

  /** Sends one batch of queued runs, each once; returns how many it took. */
  const sendBatch = () =>
    db.transaction(async (tx) => {
      const now = clock.now();
      const rows = await dueRuns(tx, "pending", now);
      for (const { r, w, integration } of rows) {
        const status = workflowStatus(w, integration);
        if (status !== "ready") {
          const why =
            status === "off" ? "Workflows were turned off for the Integration before this was sent"
            : status === "removed" ? "Falcon no longer lists this Workflow"
            : status === "disabled" ? "The Workflow was turned off in Falcon before this was sent"
            : "The Workflow no longer runs on demand";
          await finish(tx, r, w.name, "failed", { lastError: why }, now);
          continue;
        }
        try {
          const client = await clientFor(r.integrationId);
          if (!client) {
            await finish(tx, r, w.name, "failed", { lastError: "The Integration no longer exists" }, now);
            continue;
          }
          const executionId = await client.executeWorkflow(w.definitionId, r.inputs);
          await tx
            .update(workflowRuns)
            .set({ state: "running", executionId, startedAt: now, stateChangedAt: now, lastError: null, checks: 0, nextCheckAt: new Date(now.getTime() + workflowCheckDelayMs(0)) })
            .where(eq(workflowRuns.id, r.id));
          await announceRun(tx, r);
        } catch (e) {
          await finish(tx, r, w.name, "failed", { lastError: e instanceof Error ? e.message : String(e) }, now);
        }
      }
      return rows.length;
    });

  /** Reads how one batch of running runs stands in Falcon; returns how many it checked. */
  const watchBatch = () =>
    db.transaction(async (tx) => {
      const now = clock.now();
      const rows = await dueRuns(tx, "running", now);
      const byIntegration = new Map<string, typeof rows>();
      for (const row of rows) byIntegration.set(row.r.integrationId, [...(byIntegration.get(row.r.integrationId) ?? []), row]);
      for (const [integrationId, batch] of byIntegration) {
        let read: Map<string, FalconWorkflowExecution> | { error: string };
        try {
          const client = await clientFor(integrationId);
          read = client
            ? new Map((await client.workflowExecutions(batch.map((b) => b.r.executionId!))).map((e) => [e.id, e]))
            : { error: "The Integration no longer exists" };
        } catch (e) {
          read = { error: e instanceof Error ? e.message : String(e) };
        }
        for (const { r, w } of batch) {
          const execution = "error" in read ? null : read.get(r.executionId!);
          const watchedFor = now.getTime() - (r.startedAt ?? r.createdAt).getTime();
          if (execution && execution.outcome !== "running") {
            await finish(
              tx,
              r,
              w.name,
              execution.outcome,
              {
                falconStatus: execution.status,
                activities: execution.activities,
                output: keptOutput(execution.output),
                lastError: execution.outcome === "completed" ? null : (execution.error ?? `Falcon reported the execution ${execution.status.toLowerCase()}`),
                finishedAt: execution.endedAt ?? now,
                checks: r.checks + 1,
              },
              now,
            );
            continue;
          }
          if (watchedFor >= WORKFLOW_RUN_WATCH_MS) {
            await finish(tx, r, w.name, "timed_out", { lastError: "Falcon reported no outcome within 7 days; see the execution in Falcon", checks: r.checks + 1 }, now);
            continue;
          }
          const lastError = "error" in read ? read.error : execution ? execution.error : null;
          const next = {
            falconStatus: execution?.status ?? r.falconStatus,
            activities: execution?.activities ?? r.activities,
            output: execution ? keptOutput(execution.output) : r.output,
            lastError,
          };
          const changed = JSON.stringify(next) !== JSON.stringify({ falconStatus: r.falconStatus, activities: r.activities, output: r.output ?? null, lastError: r.lastError });
          await tx
            .update(workflowRuns)
            .set({ ...next, checks: r.checks + 1, nextCheckAt: new Date(now.getTime() + workflowCheckDelayMs(r.checks + 1)) })
            .where(eq(workflowRuns.id, r.id));
          // Members watching the run see each step as Falcon reports it.
          if (changed) await announceRun(tx, r);
        }
      }
      return rows.length;
    });

  let running: Promise<void> | null = null;
  return {
    /** Discovers what is due, sends what is queued and checks what is running. A tick while one is running waits for that one. */
    tick() {
      running ??= (async () => {
        try {
          await discover();
          for (let batch = 0; batch < 20; batch++) if ((await sendBatch()) < WORKFLOW_BATCH) break;
          for (let batch = 0; batch < 20; batch++) if ((await watchBatch()) < WORKFLOW_BATCH) break;
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}

export type WorkflowRunner = ReturnType<typeof createWorkflowRunner>;
