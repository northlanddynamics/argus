import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../deps";
import { InvalidIp } from "../ipinfo/ip-lookups";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const ipBody = z.object({ ip: z.string().trim().min(1).max(100) });

/**
 * IP lookups through the Organization's IPinfo Integration (ADR 0010), for Members only:
 * `GET /?ip=…` answers from the cache, fetching when nothing fresh is cached, and `POST /refresh`
 * with `{ ip }` always fetches.
 */
export const ipLookupRoutes = (deps: Deps, { ipLookups }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", zValidator("query", ipBody), async (c) => {
      try {
        return c.json({ lookup: await ipLookups.lookup(c.get("membership"), c.req.valid("query").ip) }, 200);
      } catch (e) {
        if (e instanceof InvalidIp) return c.json({ error: e.message }, 422);
        throw e;
      }
    })
    .post("/refresh", zValidator("json", ipBody), async (c) => {
      try {
        return c.json({ lookup: await ipLookups.lookup(c.get("membership"), c.req.valid("json").ip, { refresh: true }) }, 200);
      } catch (e) {
        if (e instanceof InvalidIp) return c.json({ error: e.message }, 422);
        throw e;
      }
    });
