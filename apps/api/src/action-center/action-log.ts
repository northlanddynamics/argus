import type { Db, Tx } from "../db/client";
import { actionLog } from "../db/schema";
import { secureId } from "../ids";
import { publish } from "../realtime/signals";
import type { LogAction, LogOutcome, LogSource } from "./vocabulary";

/**
 * Writing the Action Log (ADR 0016). Each module that runs an action calls one of these in the
 * transaction that runs it (a Response Action, a mark), or once it has run (a lookup, which changes
 * nothing to share a transaction with).
 */

/** Records Response Action `r`, just taken, against what it was taken on. */
export async function logResponseAction(
  tx: Tx,
  r: { id: string; organizationId: string; caseId: string | null; observableId: string | null; assetId: string | null; integrationId: string; createdById: string; createdAt: Date },
  subject: { type: string; value: string },
  source: LogSource,
) {
  await tx.insert(actionLog).values({
    id: secureId(),
    organizationId: r.organizationId,
    action: "response_action",
    responseActionId: r.id,
    observableId: r.observableId,
    assetId: r.assetId,
    valueType: subject.type,
    value: subject.value,
    integrationId: r.integrationId,
    caseId: r.caseId,
    source,
    outcome: null,
    actorId: r.createdById,
    createdAt: r.createdAt,
  });
}

/** Records Workflow Run `r`, just asked for, against the Workflow it runs (ADR 0017). */
export async function logWorkflowRun(
  tx: Tx,
  r: { id: string; organizationId: string; caseId: string | null; integrationId: string; createdById: string; createdAt: Date },
  workflowName: string,
  source: LogSource,
) {
  await tx.insert(actionLog).values({
    id: secureId(),
    organizationId: r.organizationId,
    action: "workflow_run",
    workflowRunId: r.id,
    valueType: "workflow",
    value: workflowName,
    integrationId: r.integrationId,
    caseId: r.caseId,
    source,
    outcome: null,
    actorId: r.createdById,
    createdAt: r.createdAt,
  });
}

/** A mark or a lookup that ran, and how it went. */
export type LoggedRun = {
  organizationId: string;
  action: Exclude<LogAction, "response_action" | "workflow_run">;
  observableId?: string | null;
  valueType: string;
  value: string;
  integrationId?: string | null;
  caseId?: string | null;
  source: LogSource;
  outcome: LogOutcome;
  detail?: string | null;
  actorId: string;
  at: Date;
};

/** Records a mark or a lookup, and tells the Organization's Members their Action Log changed. */
export async function logRun(db: Db | Tx, run: LoggedRun) {
  await db.insert(actionLog).values({
    id: secureId(),
    organizationId: run.organizationId,
    action: run.action,
    observableId: run.observableId ?? null,
    valueType: run.valueType,
    value: run.value,
    integrationId: run.integrationId ?? null,
    caseId: run.caseId ?? null,
    source: run.source,
    outcome: run.outcome,
    detail: run.detail ?? null,
    actorId: run.actorId,
    createdAt: run.at,
  });
  await publish(db, { kind: "actions", organizationId: run.organizationId });
}
