import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import { DASHBOARD_PERIODS, DEFAULT_DASHBOARD_PERIOD } from "../metrics/vocabulary";
import type { Modules } from "../modules";

const dashboardQuery = z.object({
  /** How many days back to look, counting today: 7, 30 or 90. */
  days: z.coerce
    .number()
    .pipe(z.union(DASHBOARD_PERIODS.map((d) => z.literal(d))))
    .default(DEFAULT_DASHBOARD_PERIOD),
});

/** The Metrics dashboard, for Members; which Cases it counts is up to the access policy. */
export const metricsRoutes = (deps: Deps, { metrics }: Modules) =>
  new Hono<MemberEnv>().use(requireMember(deps.db)).get("/dashboard", zValidator("query", dashboardQuery), async (c) => {
    const { days } = c.req.valid("query");
    return c.json({ metrics: await metrics.dashboard(c.get("membership"), days) }, 200);
  });
