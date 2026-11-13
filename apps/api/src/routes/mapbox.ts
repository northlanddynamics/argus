import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import type { Deps } from "../deps";
import { InvalidMapboxToken, MapboxTokenNotSet } from "../mapbox/mapbox";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const tokenBody = z.object({ token: z.string().trim().min(1).max(500) });

const notPermitted = { error: "Not permitted" } as const;

/** The Organization's Mapbox public token: every Member reads it to draw maps; Admins set and remove it. */
export const mapboxRoutes = (deps: Deps, { mapbox }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ mapbox: await mapbox.get(c.get("membership")) }, 200))
    .put("/", zValidator("json", tokenBody), async (c) => {
      const me = c.get("membership");
      try {
        await mapbox.set(me, c.req.valid("json").token);
        return c.json({ mapbox: await mapbox.get(me) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof InvalidMapboxToken) return c.json({ error: e.message }, 400);
        throw e;
      }
    })
    .delete("/", async (c) => {
      const me = c.get("membership");
      try {
        await mapbox.remove(me);
        return c.json({ mapbox: await mapbox.get(me) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof MapboxTokenNotSet) return c.json({ error: e.message }, 404);
        throw e;
      }
    });
