import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidTeamsWebhook, TeamsChannelNotSet, TeamsPostFailed } from "../teams/teams";

const webhookBody = z.object({ webhookUrl: z.string().trim().min(1).max(2000) });
const testBody = z.object({ webhookUrl: z.string().trim().min(1).max(2000).optional() });

const notPermitted = { error: "Not permitted" } as const;

/** The Organization's Teams channel: every Member sees whether one is set; Admins set, test and remove its webhook. */
export const teamsChannelRoutes = (deps: Deps, { teamsChannel }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ teamsChannel: await teamsChannel.get(c.get("membership")) }, 200))
    .put("/", zValidator("json", webhookBody), async (c) => {
      const me = c.get("membership");
      try {
        await teamsChannel.set(me, c.req.valid("json").webhookUrl);
        return c.json({ teamsChannel: await teamsChannel.get(me) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof InvalidTeamsWebhook) return c.json({ error: e.message }, 400);
        throw e;
      }
    })
    .delete("/", async (c) => {
      const me = c.get("membership");
      try {
        await teamsChannel.remove(me);
        return c.json({ teamsChannel: await teamsChannel.get(me) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof TeamsChannelNotSet) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/test", zValidator("json", testBody), async (c) => {
      try {
        await teamsChannel.test(c.get("membership"), c.req.valid("json").webhookUrl);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof InvalidTeamsWebhook) return c.json({ error: e.message }, 400);
        if (e instanceof TeamsChannelNotSet) return c.json({ error: e.message }, 404);
        if (e instanceof TeamsPostFailed) return c.json({ error: e.message }, 502);
        throw e;
      }
    });
