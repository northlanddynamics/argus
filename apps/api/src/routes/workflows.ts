import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { CaseClosed, CaseNotFound } from "../cases/cases";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { WORKFLOW_INPUTS_MAX_BYTES } from "../workflows/vocabulary";
import {
  InvalidWorkflowInputs,
  WORKFLOW_REASON_MAX_LENGTH,
  WorkflowNotFound,
  WorkflowNotRunnable,
  WorkflowReasonRequired,
  WorkflowRunNotFound,
  WorkflowRunNotRetryable,
} from "../workflows/workflows";

const idParam = z.object({ id: z.string().min(1).max(100) });
const runBody = z.object({
  /** The Workflow's inputs by name; checked against what its on-demand trigger declares. */
  inputs: z.record(z.string().min(1).max(200), z.union([z.string().max(WORKFLOW_INPUTS_MAX_BYTES), z.number(), z.boolean(), z.null()])).default({}),
  caseNumber: z.number().int().positive().nullable().optional(),
  reason: z.string().trim().max(WORKFLOW_REASON_MAX_LENGTH).nullable().optional(),
});
const refreshBody = z.object({ integrationId: z.string().min(1).max(100).optional() });
const runsQuery = z.object({ workflow: z.string().min(1).max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });

/** The status and body for a refusal, or null for an error that isn't one. */
function refused(e: unknown) {
  if (e instanceof NotPermitted) return { status: 403 as const, body: { error: e.message || "Not permitted" } };
  if (e instanceof WorkflowNotFound || e instanceof WorkflowRunNotFound) return { status: 404 as const, body: { error: e.message } };
  if (e instanceof CaseNotFound) return { status: 404 as const, body: { error: "Case not found" } };
  if (e instanceof InvalidWorkflowInputs || e instanceof WorkflowReasonRequired) return { status: 400 as const, body: { error: e.message } };
  if (e instanceof WorkflowNotRunnable || e instanceof WorkflowRunNotRetryable || e instanceof CaseClosed) return { status: 409 as const, body: { error: e.message } };
  return null;
}

/**
 * Falcon Fusion SOAR Workflows (ADR 0017), for Members only: `GET /` lists the discovered Workflows
 * and how discovery is doing; `POST /refresh` asks for them to be discovered afresh; `POST /:id/run`
 * queues a run, with or without a Case; `GET /runs` and `GET /runs/:id` show runs as Falcon last
 * reported them; `POST /runs/:id/retry` sends again a run Falcon couldn't be asked for.
 */
export const workflowRoutes = (deps: Deps, { workflows }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json(await workflows.list(c.get("membership")), 200))
    .post("/refresh", zValidator("json", refreshBody), async (c) => {
      await workflows.refresh(c.get("membership"), c.req.valid("json").integrationId);
      return c.json({ refreshing: true }, 200);
    })
    .get("/runs", zValidator("query", runsQuery), async (c) => {
      const { workflow, limit } = c.req.valid("query");
      return c.json({ runs: await workflows.runs(c.get("membership"), { workflowId: workflow, limit }) }, 200);
    })
    .get("/runs/:id", zValidator("param", idParam), async (c) => {
      try {
        return c.json({ run: await workflows.get(c.get("membership"), c.req.valid("param").id) }, 200);
      } catch (e) {
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    })
    .post("/runs/:id/retry", zValidator("param", idParam), async (c) => {
      try {
        await workflows.retry(c.get("membership"), c.req.valid("param").id);
        return c.json({ retried: true }, 200);
      } catch (e) {
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    })
    .post("/:id/run", zValidator("param", idParam), zValidator("json", runBody), async (c) => {
      try {
        const { inputs, ...rest } = c.req.valid("json");
        const run = await workflows.run(c.get("membership"), c.req.valid("param").id, { inputs, ...rest });
        return c.json({ run }, 201);
      } catch (e) {
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    });
