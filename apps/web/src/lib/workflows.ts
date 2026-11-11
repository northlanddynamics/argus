import { queryOptions } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api";
import { actionCenterKey } from "@/lib/action-center";

export {
  isFinished,
  type WorkflowInput,
  type WorkflowRunState,
  workflowRunStateLabel,
  type WorkflowStatus,
} from "api/workflows/vocabulary";

/** The discovered Falcon Fusion SOAR Workflows (ADR 0017), refreshed with the Action Center by the live `actions` signal. */
export const workflowsQuery = queryOptions({
  queryKey: [...actionCenterKey, "workflows"],
  queryFn: async () => {
    const res = await api.workflows.$get();
    if (!res.ok) throw new Error(await errorMessage(res, "Could not load the Workflows"));
    return res.json();
  },
});

export type WorkflowList = Awaited<ReturnType<typeof workflowsQuery.queryFn & {}>>;
export type Workflow = WorkflowList["workflows"][number];

/** One Workflow Run as Falcon last reported it; checked again every few seconds while it runs, besides the live signal. */
export const workflowRunQuery = (id: string) =>
  queryOptions({
    queryKey: [...actionCenterKey, "workflow-run", id],
    queryFn: async () => {
      const res = await api.workflows.runs[":id"].$get({ param: { id } });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not load the run"));
      const body = await res.json();
      if (!("run" in body)) throw new Error("Unexpected response");
      return body.run;
    },
    refetchInterval: (q) => (q.state.data && (q.state.data.state === "pending" || q.state.data.state === "running") ? 5_000 : false),
  });

export type WorkflowRun = Awaited<ReturnType<ReturnType<typeof workflowRunQuery>["queryFn"] & {}>>;

/** Asks for every CrowdStrike Integration's Workflows to be discovered afresh. */
export async function refreshWorkflows() {
  const res = await api.workflows.refresh.$post({ json: {} });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not refresh the Workflows"));
}

export type RunWorkflowRequest = {
  inputs: Record<string, string | number | boolean | null>;
  caseNumber?: number | null;
  reason?: string | null;
};

/** Queues a run of Workflow `id`; returns the run's id. */
export async function runWorkflow(id: string, json: RunWorkflowRequest) {
  const res = await api.workflows[":id"].run.$post({ param: { id }, json });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not run the Workflow"));
  const body = await res.json();
  if (!("run" in body)) throw new Error("Unexpected response");
  return body.run.id;
}

/** Sends again a run Falcon couldn't be asked for. */
export async function retryWorkflowRun(id: string) {
  const res = await api.workflows.runs[":id"].retry.$post({ param: { id } });
  if (!res.ok) throw new Error(await errorMessage(res, "Could not retry the run"));
}
