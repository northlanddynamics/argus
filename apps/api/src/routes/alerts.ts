import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { AlertNotFound, AlertRefused, NoAlertsToAttach } from "../alerts/alerts";
import { ALERT_STATUSES, DISMISSAL_REASONS } from "../alerts/vocabulary";
import { caseSummarySchema } from "../cases/case-summary";
import { CaseClosed, CaseNotFound } from "../cases/cases";
import { CASE_TYPES, SEVERITIES } from "../cases/vocabulary";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const queueQuery = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  integration: z.string().min(1).optional(),
  /** Only the Alerts attached to this Case. */
  case: z.coerce.number().int().positive().optional(),
});

const version = z.number().int().positive();
/** The selected Alerts, each with the version the Member saw. */
const selection = z
  .array(z.object({ id: z.string().min(1), version }))
  .min(1)
  .max(500);

const openCaseBody = z.object({
  title: z.string().trim().min(1).max(300),
  caseType: z.enum(CASE_TYPES),
  /** Defaults to the highest Severity among the Alerts attached. */
  severity: z.enum(SEVERITIES).optional(),
  summary: caseSummarySchema.optional(),
  alerts: selection,
});
const attachBody = z.object({ case: z.number().int().positive(), alerts: selection });
const dismissBody = z.object({
  reason: z.enum(DISMISSAL_REASONS),
  comment: z.string().trim().max(2000).optional(),
  alerts: selection,
});
const moveBody = z.object({ case: z.number().int().positive(), version });
const detachBody = z.object({ version });

const caseNotFound = { error: "Case not found" } as const;

/** The Alert queue and what Members do with Alerts: open Cases from them, attach, move, detach, dismiss. */
export const alertRoutes = (deps: Deps, { alerts }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", queueQuery), async (c) => {
      const { status, severity, integration, case: caseNumber } = c.req.valid("query");
      try {
        return c.json({ alerts: await alerts.list(c.get("membership"), { status, severity, integrationId: integration, caseNumber }) }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(caseNotFound, 404);
        throw e;
      }
    })
    .post("/cases", zValidator("json", openCaseBody), async (c) => {
      const { alerts: chosen, ...input } = c.req.valid("json");
      try {
        return c.json(await alerts.openCase(c.get("membership"), input, chosen), 201);
      } catch (e) {
        if (e instanceof NoAlertsToAttach) return c.json({ error: e.message, refused: e.refused }, 409);
        throw e;
      }
    })
    .post("/attach", zValidator("json", attachBody), async (c) => {
      const { case: number, alerts: chosen } = c.req.valid("json");
      try {
        return c.json(await alerts.attach(c.get("membership"), number, chosen), 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(caseNotFound, 404);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/dismiss", zValidator("json", dismissBody), async (c) => {
      const { reason, comment, alerts: chosen } = c.req.valid("json");
      return c.json(await alerts.dismiss(c.get("membership"), chosen, reason, comment || null), 200);
    })
    .get("/:id", async (c) => {
      try {
        return c.json({ alert: await alerts.get(c.get("membership"), c.req.param("id")) }, 200);
      } catch (e) {
        if (e instanceof AlertNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:id/move", zValidator("json", moveBody), async (c) => {
      const { case: number, version: seen } = c.req.valid("json");
      try {
        await alerts.move(c.get("membership"), c.req.param("id"), seen, number);
        return c.json({ alert: await alerts.get(c.get("membership"), c.req.param("id")) }, 200);
      } catch (e) {
        if (e instanceof CaseNotFound) return c.json(caseNotFound, 404);
        if (e instanceof AlertRefused) return refused(e);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .post("/:id/detach", zValidator("json", detachBody), async (c) => {
      try {
        await alerts.detach(c.get("membership"), c.req.param("id"), c.req.valid("json").version);
        return c.json({ alert: await alerts.get(c.get("membership"), c.req.param("id")) }, 200);
      } catch (e) {
        if (e instanceof AlertRefused) return refused(e);
        if (e instanceof CaseClosed) return c.json({ error: e.message }, 409);
        throw e;
      }
    });

/** A refused one-Alert action: 404 when there is no such Alert, otherwise 409 with the reason. */
function refused(e: AlertRefused) {
  const status = e.refusal.reason === "not_found" ? 404 : 409;
  return Response.json({ error: e.message, refusal: e.refusal }, { status });
}
