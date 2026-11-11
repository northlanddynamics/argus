/**
 * Workflows and Workflow Runs (GLOSSARY.md, ADR 0017): Falcon Fusion SOAR workflows Argus discovers
 * through a CrowdStrike Integration, and each run of one Argus asks Falcon for. Plain values shared
 * with the SPA.
 */

/**
 * Where a Workflow Run stands. `pending`: queued, not yet sent to Falcon. `running`: Falcon took it
 * and Argus is watching for its outcome. Then Falcon's outcome: `completed`, `failed` or
 * `cancelled`; or `failed` without an execution when Falcon couldn't be asked to run it; or
 * `timed_out`, when Falcon reported no outcome within `WORKFLOW_RUN_WATCH_MS`.
 */
export const WORKFLOW_RUN_STATES = ["pending", "running", "completed", "failed", "cancelled", "timed_out"] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];

export const workflowRunStateLabel: Record<WorkflowRunState, string> = {
  pending: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "No outcome",
};

/** States a Workflow Run doesn't leave: Argus has stopped watching it. */
export const FINISHED_WORKFLOW_RUN_STATES = ["completed", "failed", "cancelled", "timed_out"] as const satisfies readonly WorkflowRunState[];
export const isFinished = (s: WorkflowRunState) => (FINISHED_WORKFLOW_RUN_STATES as readonly string[]).includes(s);

/** How long Argus watches a running Workflow for its outcome before giving up on it. */
export const WORKFLOW_RUN_WATCH_MS = 7 * 24 * 60 * 60_000;

/** The kinds of value a Workflow's input takes, as its on-demand trigger's schema declares them. */
export const WORKFLOW_INPUT_TYPES = ["string", "number", "integer", "boolean"] as const;
export type WorkflowInputType = (typeof WORKFLOW_INPUT_TYPES)[number];

/** One input a Workflow's on-demand trigger takes. */
export type WorkflowInput = {
  /** Its key, as Falcon expects it in the run's inputs. */
  name: string;
  /** What the run dialog calls it: its schema's title, or its key. */
  label: string;
  type: WorkflowInputType;
  required: boolean;
  description: string | null;
  /** The only values it takes, when its schema lists them. */
  options: string[] | null;
};

/** The inputs a Workflow Run is asked for with. */
export type WorkflowInputValues = Record<string, string | number | boolean>;

/** One step of a Workflow Run, as Falcon last reported it. */
export type WorkflowActivity = { name: string; status: string };

/**
 * Why a Workflow can't be run from Argus now: its Integration's Workflows setting is off or it is
 * paused; or it runs on its own trigger, not on demand; or it is off in Falcon; or Falcon no longer
 * lists it.
 */
export const WORKFLOW_STATUSES = ["ready", "off", "paused", "not_on_demand", "disabled", "removed"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const workflowStatusLabel: Record<WorkflowStatus, string> = {
  ready: "Ready",
  off: "Workflows off",
  paused: "Paused",
  not_on_demand: "Runs on its own trigger",
  disabled: "Off in Falcon",
  removed: "No longer in Falcon",
};

/** The largest inputs a run may be asked for with, as JSON. */
export const WORKFLOW_INPUTS_MAX_BYTES = 16 * 1024;
/** The most of a run's output Argus keeps, as JSON; anything larger is cut and says so. */
export const WORKFLOW_OUTPUT_MAX_BYTES = 32 * 1024;
