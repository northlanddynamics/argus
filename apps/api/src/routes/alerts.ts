import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { ALERT_STATUSES } from "../alerts/vocabulary";
import { SEVERITIES } from "../cases/vocabulary";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const queueQuery = z.object({
  status: z.enum(ALERT_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  integration: z.string().min(1).optional(),
});

/** The Alert queue, for Members. */
export const alertRoutes = (deps: Deps, { alerts }: Modules) =>
  new Hono<MemberEnv>().use(requireMember(deps.db)).get("/", zValidator("query", queueQuery), async (c) => {
    const { status, severity, integration } = c.req.valid("query");
    return c.json({ alerts: await alerts.list(c.get("membership"), { status, severity, integrationId: integration }) }, 200);
  });
