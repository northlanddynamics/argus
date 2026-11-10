import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { AlreadyLinked, CaseNotVisible, LogEntryNotFound, NothingToRun } from "../action-center/action-center";
import { CENTER_ACTIONS, REASON_MAX_LENGTH } from "../action-center/vocabulary";
import { CaseClosed, CaseNotFound } from "../cases/cases";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidValue, NotLinked } from "../observables/observables";
import {
  IgnoredNotConfirmed,
  IntegrationNotEligible,
  NotDismissable,
  NotRemovable,
  NotRetryable,
  ReasonRequired,
  RelyingCasesNotConfirmed,
  ResponseActionNotFound,
} from "../response-actions/response-actions";

const runBody = z.object({
  /** Containment is run on a Case, through its own confirmation (ADR 0009), not here. */
  action: z.enum(CENTER_ACTIONS).exclude(["contain", "lift_containment"]),
  /** One value per line, or any text: Observables are pulled out of it as Bulk Lookup does. */
  text: z.string().min(1).max(100_000),
  integrationIds: z.array(z.string().min(1).max(100)).max(50).optional(),
  caseNumber: z.number().int().positive().nullable().optional(),
  reason: z.string().trim().max(REASON_MAX_LENGTH).nullable().optional(),
  internal: z.boolean().optional(),
  confirmIgnored: z.boolean().default(false),
});

const logQuery = z.object({
  link: z.enum(["linked", "unlinked"]).optional(),
  group: z.enum(["respond", "lookup", "mark"]).optional(),
  by: z.string().min(1).max(100).optional(),
  before: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const idParam = z.object({ id: z.string().min(1).max(100) });
const linkBody = z.object({ caseNumber: z.number().int().positive() });
const removeBody = z.object({ confirmRelying: z.boolean().default(false) });

/** Well over the text a run reads, so a larger body is refused before it is read. */
const MAX_BODY = 1024 * 1024;

/**
 * The Action Center (ADR 0016), for Members only: `GET /` is the catalogue of every action and whether
 * each can run now, and `POST /run` runs one on the values in some text, with or without a Case.
 */
export const actionCenterRoutes = (deps: Deps, { actionCenter }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .use(bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "The text is over 100 KB. Split it and run each part." }, 413) }))
    .get("/", async (c) => c.json({ actions: await actionCenter.catalogue(c.get("membership")) }, 200))
    .post("/run", zValidator("json", runBody), async (c) => {
      try {
        return c.json(await actionCenter.run(c.get("membership"), c.req.valid("json")), 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: e.message || "Not permitted" }, 403);
        if (e instanceof CaseNotVisible || e instanceof CaseNotFound) return c.json({ error: "Case not found" }, 404);
        if (e instanceof NotLinked) return c.json({ error: e.message }, 404);
        if (e instanceof NothingToRun || e instanceof InvalidValue || e instanceof ReasonRequired || e instanceof IntegrationNotEligible) {
          return c.json({ error: e.message }, 400);
        }
        if (e instanceof IgnoredNotConfirmed) return c.json({ error: e.message, ignored: e.observables }, 409);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    });

/** The status and body for an Action Log refusal, or null for an error that isn't one. */
function refused(e: unknown) {
  if (e instanceof LogEntryNotFound || e instanceof ResponseActionNotFound) return { status: 404 as const, body: { error: e.message } };
  if (e instanceof NotRetryable || e instanceof NotRemovable || e instanceof NotDismissable || e instanceof AlreadyLinked || e instanceof CaseClosed) {
    return { status: 409 as const, body: { error: e.message } };
  }
  return null;
}

/**
 * The Action Log (ADR 0016), for Members only: `GET /` lists runs newest first (`link`, `group`, `by`
 * narrow it, and `before` pages it), `POST /:id/link` links a run with no Case to one, and
 * `POST /:id/retry`, `/remove` and `/dismiss` act on the Response Action of a run with no Case.
 */
export const actionLogRoutes = (deps: Deps, { actionCenter }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", logQuery), async (c) => {
      const { by, ...rest } = c.req.valid("query");
      return c.json(await actionCenter.log(c.get("membership"), { ...rest, byId: by }), 200);
    })
    .post("/:id/link", zValidator("param", idParam), zValidator("json", linkBody), async (c) => {
      try {
        await actionCenter.linkToCase(c.get("membership"), c.req.valid("param").id, c.req.valid("json").caseNumber);
        return c.json({ linked: true }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json({ error: "Case not found" }, 404);
        if (e instanceof NotPermitted) return c.json({ error: e.message || "Not permitted" }, 403);
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    })
    .post("/:id/retry", zValidator("param", idParam), async (c) => {
      try {
        await actionCenter.responseAction(c.get("membership"), c.req.valid("param").id, "retry");
        return c.json({ done: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: e.message || "Not permitted" }, 403);
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    })
    .post("/:id/remove", zValidator("param", idParam), zValidator("json", removeBody), async (c) => {
      try {
        await actionCenter.responseAction(c.get("membership"), c.req.valid("param").id, "remove", c.req.valid("json"));
        return c.json({ done: true }, 200);
      } catch (e) {
        if (e instanceof RelyingCasesNotConfirmed) return c.json({ error: e.message, cases: e.cases, otherCases: e.otherCases }, 409);
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    })
    .post("/:id/dismiss", zValidator("param", idParam), async (c) => {
      try {
        await actionCenter.responseAction(c.get("membership"), c.req.valid("param").id, "dismiss");
        return c.json({ done: true }, 200);
      } catch (e) {
        const r = refused(e);
        if (r) return c.json(r.body, r.status);
        throw e;
      }
    });
