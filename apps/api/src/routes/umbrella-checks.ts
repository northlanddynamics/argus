import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidDomain } from "../umbrella/domain-checks";

const domainBody = z.object({ domain: z.string().trim().min(1).max(320) });

/**
 * Domain checks against the Organization's Cisco Umbrella destination lists (ADR 0014), for Members
 * only: `GET /?domain=…` (a domain, or an email address, checked by its domain) answers from what was
 * read of the lists lately, reading them when that is stale, and `POST /refresh` with `{ domain }`
 * always reads them.
 */
export const umbrellaCheckRoutes = (deps: Deps, { umbrellaChecks }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", domainBody), async (c) => {
      try {
        return c.json({ check: await umbrellaChecks.check(c.get("membership"), c.req.valid("query").domain) }, 200);
      } catch (e) {
        if (e instanceof InvalidDomain) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/refresh", zValidator("json", domainBody), async (c) => {
      try {
        return c.json({ check: await umbrellaChecks.check(c.get("membership"), c.req.valid("json").domain, { refresh: true }) }, 200);
      } catch (e) {
        if (e instanceof InvalidDomain) return c.json({ error: e.message }, 422);
        throw e;
      }
    });
