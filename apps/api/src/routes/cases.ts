import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { caseSummarySchema } from "../cases/case-summary";
import { CaseClosed, CaseNotClosed, CaseNotFound, NotAMember, NotPermitted, StaleSummary } from "../cases/cases";
import { CASE_AUDIT_ACTIONS, CASE_TYPES, RESOLUTIONS, SEVERITIES, STATUSES } from "../cases/vocabulary";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const numberParam = z.object({ number: z.coerce.number().int().positive() });
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Not a date");

const openBody = z.object({
  title: z.string().trim().min(1).max(300),
  caseType: z.enum(CASE_TYPES),
  severity: z.enum(SEVERITIES),
  summary: caseSummarySchema.optional(),
});

const listQuery = z.object({
  view: z.enum(["open", "mine", "unassigned", "closed"]).optional(),
  status: z.enum(STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  caseType: z.enum(CASE_TYPES).optional(),
});

const changeBody = z.object({
  // Closing records a Resolution, so it has its own route.
  status: z
    .enum(STATUSES)
    .refine((s) => s !== "closed", "Close a Case with a Resolution")
    .optional(),
  severity: z.enum(SEVERITIES).optional(),
  caseType: z.enum(CASE_TYPES).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  /** Admins, the Owner and the Assignee only. */
  restricted: z.boolean().optional(),
});

const closeBody = z.object({ resolution: z.enum(RESOLUTIONS) });

const summaryBody = z.object({ summary: caseSummarySchema, version: z.number().int().positive() });

const auditQuery = z.object({
  actor: z.string().min(1).optional(),
  action: z.enum(CASE_AUDIT_ACTIONS).optional(),
  from: isoDate.optional(),
});

const notFound = { error: "Case not found" } as const;

/** The result, or null if the Member can't see the Case (another Organization's, or Restricted). */
const unlessNotFound = <T>(work: Promise<T>) =>
  work.catch((e: unknown) => {
    if (e instanceof CaseNotFound) return null;
    throw e;
  });

/** Turns a refusal to change a Closed Case into the result it carries, and rethrows anything else. */
const closedConflict = (e: unknown) => {
  if (e instanceof CaseClosed || e instanceof CaseNotClosed) return { error: e.message };
  throw e;
};

/** Cases: open, list, view, change, close, reopen, the Case Summary and the Case Audit Log. */
export const caseRoutes = (deps: Deps, { cases: store }: Modules) => {
  return new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .post("/", zValidator("json", openBody), async (c) => {
      const opened = await store.open(c.get("membership"), c.req.valid("json"));
      return c.json({ case: opened }, 201);
    })
    .get("/", zValidator("query", listQuery), async (c) => {
      return c.json(await store.list(c.get("membership"), c.req.valid("query")), 200);
    })
    .get("/:number", zValidator("param", numberParam), async (c) => {
      const found = await unlessNotFound(store.view(c.get("membership"), c.req.valid("param").number));
      if (!found) return c.json(notFound, 404);
      return c.json({ case: found }, 200);
    })
    .patch("/:number", zValidator("param", numberParam), zValidator("json", changeBody), async (c) => {
      try {
        const changed = await store.change(c.get("membership"), c.req.valid("param").number, c.req.valid("json"));
        // The change went through, but left the Member unable to see the Case.
        if (!changed) return c.json({ case: null }, 200);
        return c.json({ case: changed }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(notFound, 404);
        if (e instanceof NotAMember) return c.json({ error: "The Assignee must be a Member of the Organization" }, 400);
        if (e instanceof NotPermitted) return c.json({ error: "Only an Admin or the Assignee can change whether a Case is Restricted" }, 403);
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/close", zValidator("param", numberParam), zValidator("json", closeBody), async (c) => {
      try {
        const closed = await unlessNotFound(store.close(c.get("membership"), c.req.valid("param").number, c.req.valid("json").resolution));
        if (!closed) return c.json(notFound, 404);
        return c.json({ case: closed }, 200);
      } catch (e) {
        return c.json(closedConflict(e), 409);
      }
    })
    .post("/:number/reopen", zValidator("param", numberParam), async (c) => {
      try {
        const reopened = await unlessNotFound(store.reopen(c.get("membership"), c.req.valid("param").number));
        if (!reopened) return c.json(notFound, 404);
        return c.json({ case: reopened }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json({ error: "Only an Admin can reopen a Case" }, 403);
        return c.json(closedConflict(e), 409);
      }
    })
    .put("/:number/summary", zValidator("param", numberParam), zValidator("json", summaryBody), async (c) => {
      const { summary, version } = c.req.valid("json");
      try {
        const saved = await unlessNotFound(store.saveSummary(c.get("membership"), c.req.valid("param").number, summary, version));
        if (!saved) return c.json(notFound, 404);
        return c.json({ summary: saved }, 200);
      } catch (e) {
        if (e instanceof StaleSummary) return c.json({ error: e.message, current: e.current }, 409);
        return c.json(closedConflict(e), 409);
      }
    })
    .get("/:number/audit-log", zValidator("param", numberParam), zValidator("query", auditQuery), async (c) => {
      const { actor, action, from } = c.req.valid("query");
      const entries = await unlessNotFound(
        store.auditLog(c.get("membership"), c.req.valid("param").number, {
          actorId: actor,
          action,
          from: from ? new Date(from) : undefined,
        }),
      );
      if (!entries) return c.json(notFound, 404);
      return c.json({ entries }, 200);
    });
};
