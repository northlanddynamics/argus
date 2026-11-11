import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { visibleCases } from "../access/policy";
import { logWorkflowRun } from "../action-center/action-log";
import type { LogSource } from "../action-center/vocabulary";
import { recordOrgAudit } from "../audit/org-audit-log";
import { recordCaseAudit } from "../cases/case-audit-log";
import { actorOf, lockCase } from "../cases/cases";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db/client";
import { actionLog, cases, falconWorkflows, integrations, user, workflowRuns } from "../db/schema";
import { secureId } from "../ids";
import type { Membership } from "../members/membership";
import { publish } from "../realtime/signals";
import {
  isFinished,
  WORKFLOW_INPUTS_MAX_BYTES,
  type WorkflowActivity,
  type WorkflowInput,
  type WorkflowInputValues,
  type WorkflowRunState,
  type WorkflowStatus,
  workflowStatusLabel,
} from "./vocabulary";

/**
 * Workflows (ADR 0017): the Falcon Fusion SOAR workflows each CrowdStrike Integration has discovered,
 * and the Workflow Runs Members ask for. Members only; Guests never see Workflows or their runs.
 *
 * Discovery and sending are the worker's (`runner.ts`): asking to refresh only marks an Integration's
 * Workflows due, and running one only queues it, recorded in the Action Log and the Audit Log of its
 * Case, or the Organization's for a run without one. The worker then sends it and watches it until
 * Falcon reports how it ended, and a signal brings each change to the Action Center.
 */

export class WorkflowNotFound extends Error {
  constructor() {
    super("No such Workflow");
  }
}
export class WorkflowRunNotFound extends Error {
  constructor() {
    super("No such Workflow Run");
  }
}
/** The Workflow can't be run now; the message says why. */
export class WorkflowNotRunnable extends Error {}
/** The inputs given aren't what the Workflow takes; the message says how. */
export class InvalidWorkflowInputs extends Error {}
/** A run without a Case must say why it is run. */
export class WorkflowReasonRequired extends Error {
  constructor() {
    super("Give a reason, or choose a Case: a Workflow run without a Case is recorded with why it was run");
  }
}
/** Only a run Falcon couldn't be asked for can be retried; run it again instead. */
export class WorkflowRunNotRetryable extends Error {
  constructor() {
    super("Only a run Falcon couldn't be asked for can be retried; run the Workflow again instead");
  }
}
export class WorkflowRunAlreadyLinked extends Error {
  constructor() {
    super("That run is already linked to a Case");
  }
}

/** The longest reason a run without a Case may give. */
export const WORKFLOW_REASON_MAX_LENGTH = 500;

/** One discovered Workflow, as the Action Center lists it. */
export type WorkflowView = {
  id: string;
  definitionId: string;
  name: string;
  description: string | null;
  integration: { id: string; name: string };
  status: WorkflowStatus;
  statusText: string;
  inputs: WorkflowInput[];
  lastSeenAt: string;
};

/** How discovery through one CrowdStrike Integration is doing. */
export type WorkflowSourceView = {
  integration: { id: string; name: string };
  /** Whether Members may run its Workflows. */
  enabled: boolean;
  paused: boolean;
  /** A discovery is asked for and the worker hasn't done it yet. */
  refreshing: boolean;
  checkedAt: string | null;
  /** Why the last discovery failed, if it did. */
  error: string | null;
};

/** One Workflow Run, as the Action Center and the Action Log show it. */
export type WorkflowRunView = {
  id: string;
  workflow: { id: string; name: string; inputs: WorkflowInput[] };
  integration: { id: string; name: string };
  case: { number: number; title: string } | null;
  by: { id: string; name: string };
  reason: string | null;
  inputs: WorkflowInputValues;
  state: WorkflowRunState;
  /** Falcon's own word for where it stands, as last read. */
  falconStatus: string | null;
  activities: WorkflowActivity[];
  output: unknown;
  error: string | null;
  executionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Whether a Member may Retry it: only one Falcon couldn't be asked for. */
  retryable: boolean;
};

/** Why a discovered Workflow can't be run now, if it can't. */
export function workflowStatus(
  w: { onDemand: boolean; enabled: boolean; removedAt: Date | null },
  i: { workflows: boolean; paused: boolean },
): WorkflowStatus {
  if (w.removedAt) return "removed";
  if (!w.onDemand) return "not_on_demand";
  if (!w.enabled) return "disabled";
  if (!i.workflows) return "off";
  if (i.paused) return "paused";
  return "ready";
}

/** Whether an input was left empty. */
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());

/**
 * `given` as Workflow inputs `declared` take them: each value of its declared type (numbers and
 * booleans may come as text), each required one given, nothing undeclared. A Workflow that declares
 * nothing takes any text, number or true/false values. Throws `InvalidWorkflowInputs`.
 */
export function checkInputs(declared: readonly WorkflowInput[], given: Record<string, unknown>): WorkflowInputValues {
  const values: WorkflowInputValues = {};
  if (!declared.length) {
    for (const [name, v] of Object.entries(given)) {
      if (blank(v)) continue;
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new InvalidWorkflowInputs(`${name}: give text, a number or true/false`);
      values[name] = typeof v === "string" ? v.trim() : v;
    }
  } else {
    const known = new Set(declared.map((d) => d.name));
    const unknown = Object.keys(given).filter((k) => !known.has(k) && !blank(given[k]));
    if (unknown.length) throw new InvalidWorkflowInputs(`This Workflow takes no ${unknown.join(", ")}`);
    for (const d of declared) {
      const v = given[d.name];
      if (blank(v)) {
        if (d.required && d.type !== "boolean") throw new InvalidWorkflowInputs(`${d.label} is required`);
        if (d.required) values[d.name] = false;
        continue;
      }
      if (d.type === "boolean") {
        if (typeof v === "boolean") values[d.name] = v;
        else if (v === "true" || v === "false") values[d.name] = v === "true";
        else throw new InvalidWorkflowInputs(`${d.label}: give true or false`);
      } else if (d.type === "number" || d.type === "integer") {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : Number.NaN;
        if (!Number.isFinite(n)) throw new InvalidWorkflowInputs(`${d.label}: give a number`);
        if (d.type === "integer" && !Number.isInteger(n)) throw new InvalidWorkflowInputs(`${d.label}: give a whole number`);
        values[d.name] = n;
      } else {
        if (typeof v !== "string" && typeof v !== "number") throw new InvalidWorkflowInputs(`${d.label}: give text`);
        values[d.name] = String(v).trim();
      }
      if (d.options && !d.options.includes(String(values[d.name]))) throw new InvalidWorkflowInputs(`${d.label}: choose one of ${d.options.join(", ")}`);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(values)).length > WORKFLOW_INPUTS_MAX_BYTES) throw new InvalidWorkflowInputs("The inputs are too large");
  return values;
}

/** "hostname=FIN-LT-0231 · notify=true", as an Audit Log says what a run was asked for with. */
export const inputsLabel = (inputs: WorkflowInputValues) =>
  Object.entries(inputs)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ") || "no inputs";

/** Records a change to run `r` in its Case's Audit Log, or the Organization's for a run without one. */
export async function recordRunAudit(
  tx: Tx,
  r: { organizationId: string; caseId: string | null; reason: string | null },
  entry: {
    action: "workflow_run.requested" | "workflow_run.retried" | "workflow_run.linked" | "workflow_run.finished";
    actor: { type: "member"; id: string; name: string } | { type: "system"; name: string };
    workflowName: string;
    after?: string | null;
    now: Date;
  },
) {
  if (r.caseId) {
    await recordCaseAudit(tx, {
      organizationId: r.organizationId,
      caseId: r.caseId,
      occurredAt: entry.now,
      actor: entry.actor,
      action: entry.action,
      target: entry.workflowName,
      after: entry.after ?? null,
    });
    return;
  }
  await recordOrgAudit(tx, {
    organizationId: r.organizationId,
    occurredAt: entry.now,
    actor: entry.actor.type === "member" ? entry.actor : { type: "system" },
    category: "workflows",
    action: entry.action,
    target: entry.workflowName,
    after: entry.after ?? r.reason,
  });
}

/** Tells the Organization's Members, and the run's Case's, that a Workflow Run changed. */
export async function announceRun(tx: Tx, r: { organizationId: string; caseId: string | null }) {
  await publish(tx, { kind: "actions", organizationId: r.organizationId });
  if (r.caseId) await publish(tx, { kind: "case", organizationId: r.organizationId, caseId: r.caseId, membersOnly: true });
}

export type RunWorkflowInput = {
  inputs: Record<string, unknown>;
  /** The Case to run it for; null or left out for none. */
  caseNumber?: number | null;
  /** Why, for a run without a Case. */
  reason?: string | null;
};

/** Workflow `id` of `me`'s Organization, with its Integration, unless the Integration was deleted. */
async function workflowOf(dbOrTx: Db | Tx, me: Membership, id: string) {
  const [found] = await dbOrTx
    .select({ w: falconWorkflows, integration: { id: integrations.id, name: integrations.name, workflows: integrations.workflows, paused: integrations.paused } })
    .from(falconWorkflows)
    .innerJoin(integrations, eq(falconWorkflows.integrationId, integrations.id))
    .where(and(eq(falconWorkflows.id, id), eq(falconWorkflows.organizationId, me.organizationId), isNull(integrations.deletedAt)));
  if (!found) throw new WorkflowNotFound();
  return found;
}

export function workflowStore({ db, clock }: { db: Db; clock: Clock }) {
  const runColumns = {
    r: workflowRuns,
    workflowName: falconWorkflows.name,
    workflowInputs: falconWorkflows.inputs,
    integrationName: integrations.name,
    caseNumber: cases.number,
    caseTitle: cases.title,
    byName: user.name,
  };
  const runsFrom = (dbOrTx: Db | Tx) =>
    dbOrTx
      .select(runColumns)
      .from(workflowRuns)
      .innerJoin(falconWorkflows, eq(workflowRuns.workflowId, falconWorkflows.id))
      .innerJoin(integrations, eq(workflowRuns.integrationId, integrations.id))
      .leftJoin(cases, eq(workflowRuns.caseId, cases.id))
      .innerJoin(user, eq(workflowRuns.createdById, user.id));
  type RunRow = Awaited<ReturnType<ReturnType<typeof runsFrom>["where"]>>[number];

  const toView = (row: RunRow): WorkflowRunView => ({
    id: row.r.id,
    workflow: { id: row.r.workflowId, name: row.workflowName, inputs: row.workflowInputs },
    integration: { id: row.r.integrationId, name: row.integrationName },
    case: row.caseNumber !== null && row.caseTitle !== null ? { number: row.caseNumber, title: row.caseTitle } : null,
    by: { id: row.r.createdById, name: row.byName },
    reason: row.r.reason,
    inputs: row.r.inputs,
    state: row.r.state,
    falconStatus: row.r.falconStatus,
    activities: row.r.activities,
    output: row.r.output ?? null,
    error: row.r.lastError,
    executionId: row.r.executionId,
    createdAt: row.r.createdAt.toISOString(),
    startedAt: row.r.startedAt?.toISOString() ?? null,
    finishedAt: row.r.finishedAt?.toISOString() ?? null,
    retryable: row.r.state === "failed" && row.r.executionId === null,
  });

  /** Run `id` of `me`'s Organization, unless it is on a Case they can't see. */
  const runOf = async (dbOrTx: Db | Tx, me: Membership, id: string) => {
    const [row] = await runsFrom(dbOrTx).where(
      and(eq(workflowRuns.id, id), eq(workflowRuns.organizationId, me.organizationId), or(isNull(workflowRuns.caseId), visibleCases(me))),
    );
    if (!row) throw new WorkflowRunNotFound();
    return row;
  };

  return {
    /**
     * The Organization's discovered Workflows, runnable ones first and then by name, and how
     * discovery is doing through each CrowdStrike Integration.
     */
    async list(me: Membership): Promise<{ sources: WorkflowSourceView[]; workflows: WorkflowView[] }> {
      const sources = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, me.organizationId), eq(integrations.provider, "crowdstrike"), isNull(integrations.deletedAt)))
        .orderBy(asc(integrations.createdAt), asc(integrations.id));
      const rows = await db
        .select({ w: falconWorkflows, integrationName: integrations.name, on: integrations.workflows, paused: integrations.paused })
        .from(falconWorkflows)
        .innerJoin(integrations, eq(falconWorkflows.integrationId, integrations.id))
        .where(and(eq(falconWorkflows.organizationId, me.organizationId), isNull(integrations.deletedAt)));
      const workflows = rows
        .map(({ w, integrationName, on, paused }): WorkflowView => {
          const status = workflowStatus(w, { workflows: on, paused });
          return {
            id: w.id,
            definitionId: w.definitionId,
            name: w.name,
            description: w.description,
            integration: { id: w.integrationId, name: integrationName },
            status,
            statusText: workflowStatusLabel[status],
            inputs: w.inputs,
            lastSeenAt: w.lastSeenAt.toISOString(),
          };
        })
        .toSorted((a, b) => Number(a.status === "removed") - Number(b.status === "removed") || a.name.localeCompare(b.name) || a.integration.name.localeCompare(b.integration.name));
      return {
        sources: sources.map((i) => ({
          integration: { id: i.id, name: i.name },
          enabled: i.workflows,
          paused: i.paused,
          refreshing: i.workflowsDue,
          checkedAt: i.workflowsCheckedAt?.toISOString() ?? null,
          error: i.workflowsError,
        })),
        workflows,
      };
    },

    /** Asks for the Workflows of every CrowdStrike Integration (or just `integrationId`) to be discovered afresh. Any Member. */
    async refresh(me: Membership, integrationId?: string) {
      await db.transaction(async (tx) => {
        await tx
          .update(integrations)
          .set({ workflowsDue: true })
          .where(
            and(
              eq(integrations.organizationId, me.organizationId),
              eq(integrations.provider, "crowdstrike"),
              isNull(integrations.deletedAt),
              integrationId ? eq(integrations.id, integrationId) : undefined,
            ),
          );
        await publish(tx, { kind: "actions", organizationId: me.organizationId });
      });
    },

    /**
     * Queues a run of Workflow `id` with `input.inputs`, for Case `input.caseNumber` or, with a reason,
     * for none. Throws `WorkflowNotRunnable` unless it can run now, `InvalidWorkflowInputs`,
     * `WorkflowReasonRequired`, and `CaseNotFound` or `CaseClosed` for a Case that can't take it.
     */
    async run(me: Membership, id: string, input: RunWorkflowInput, source: LogSource = "action_center") {
      const now = clock.now();
      const reason = input.reason?.trim() || null;
      return db.transaction(async (tx) => {
        const { w, integration } = await workflowOf(tx, me, id);
        const status = workflowStatus(w, integration);
        if (status !== "ready") throw new WorkflowNotRunnable(`${w.name} can't be run now: ${workflowStatusLabel[status]}`);
        const inputs = checkInputs(w.inputs, input.inputs);
        const theCase = input.caseNumber != null ? await lockCase(tx, me, input.caseNumber) : null;
        if (!theCase && !reason) throw new WorkflowReasonRequired();
        const [r] = await tx
          .insert(workflowRuns)
          .values({
            id: secureId(),
            organizationId: me.organizationId,
            integrationId: w.integrationId,
            workflowId: w.id,
            caseId: theCase?.id ?? null,
            reason: theCase ? null : reason,
            inputs,
            state: "pending",
            createdById: me.userId,
            createdAt: now,
            stateChangedAt: now,
            nextCheckAt: now,
          })
          .returning();
        await logWorkflowRun(tx, r!, w.name, source);
        await recordRunAudit(tx, r!, { action: "workflow_run.requested", actor: actorOf(me) as { type: "member"; id: string; name: string }, workflowName: w.name, after: inputsLabel(inputs), now });
        await announceRun(tx, r!);
        return { id: r!.id };
      });
    },

    /** Run `id`, unless it is on a Case `me` can't see. */
    async get(me: Membership, id: string) {
      return toView(await runOf(db, me, id));
    },

    /** The newest runs of the Organization, or of Workflow `workflowId`, leaving out those on Cases `me` can't see. */
    async runs(me: Membership, { workflowId, limit = 50 }: { workflowId?: string; limit?: number } = {}) {
      const rows = await runsFrom(db)
        .where(
          and(
            eq(workflowRuns.organizationId, me.organizationId),
            or(isNull(workflowRuns.caseId), visibleCases(me)),
            workflowId ? eq(workflowRuns.workflowId, workflowId) : undefined,
          ),
        )
        .orderBy(desc(workflowRuns.seq))
        .limit(Math.min(limit, 200));
      return rows.map(toView);
    },

    /**
     * Sends run `id` again: only one Falcon couldn't be asked for, as the Workflow can still be run.
     * A run on a Closed Case needs it reopened first.
     */
    async retry(me: Membership, id: string) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const row = await runOf(tx, me, id);
        if (row.caseNumber !== null) await lockCase(tx, me, row.caseNumber);
        const [locked] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).for("update");
        if (!locked || locked.state !== "failed" || locked.executionId !== null) throw new WorkflowRunNotRetryable();
        const { w, integration } = await workflowOf(tx, me, locked.workflowId);
        const status = workflowStatus(w, integration);
        if (status !== "ready") throw new WorkflowNotRunnable(`${w.name} can't be run now: ${workflowStatusLabel[status]}`);
        await tx
          .update(workflowRuns)
          .set({ state: "pending", lastError: null, finishedAt: null, nextCheckAt: now, stateChangedAt: now })
          .where(eq(workflowRuns.id, id));
        await recordRunAudit(tx, locked, { action: "workflow_run.retried", actor: actorOf(me) as { type: "member"; id: string; name: string }, workflowName: w.name, now });
        await announceRun(tx, locked);
      });
    },

    /** Links run `id`, which has no Case, to Case `number` for good; its Action Log row names the Case too. */
    async linkToCase(me: Membership, id: string, number: number) {
      const now = clock.now();
      await db.transaction(async (tx) => {
        const row = await runOf(tx, me, id);
        if (row.r.caseId) throw new WorkflowRunAlreadyLinked();
        const current = await lockCase(tx, me, number);
        const [linked] = await tx
          .update(workflowRuns)
          .set({ caseId: current.id })
          .where(and(eq(workflowRuns.id, id), isNull(workflowRuns.caseId)))
          .returning();
        if (!linked) throw new WorkflowRunAlreadyLinked();
        await tx.update(actionLog).set({ caseId: current.id }).where(eq(actionLog.workflowRunId, id));
        const actor = actorOf(me) as { type: "member"; id: string; name: string };
        await recordCaseAudit(tx, {
          organizationId: me.organizationId,
          caseId: current.id,
          occurredAt: now,
          actor,
          action: "workflow_run.linked",
          target: row.workflowName,
          after: isFinished(linked.state) ? linked.state : null,
        });
        await recordRunAudit(tx, { ...linked, caseId: null }, { action: "workflow_run.linked", actor, workflowName: row.workflowName, after: `C-${number}`, now });
        await announceRun(tx, linked);
      });
    },

  };
}

export type WorkflowStore = ReturnType<typeof workflowStore>;
