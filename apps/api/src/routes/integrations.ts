import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import { FALCON_CLOUDS } from "../alerts/vocabulary";
import type { Deps } from "../deps";
import { IntegrationNameTaken, IntegrationNotFound } from "../integrations/integrations";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";

const credentialsBody = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
});
const createBody = credentialsBody.extend({
  name: z.string().trim().min(1).max(80),
  cloud: z.enum(FALCON_CLOUDS),
  /** Off unless asked for: an Integration only reads from Falcon until an Admin allows write-back. */
  writeBack: z.boolean().default(false),
});
const writeBackBody = z.object({ enabled: z.boolean() });

const notPermitted = { error: "Not permitted" } as const;

/** Integrations: every Member sees them and their health; Admins add, rotate, pause, resume them and set their write-back. */
export const integrationRoutes = (deps: Deps, { integrations }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ integrations: await integrations.list(c.get("membership")) }, 200))
    .post("/", zValidator("json", createBody), async (c) => {
      const { name, cloud, clientId, clientSecret, writeBack } = c.req.valid("json");
      try {
        const created = await integrations.create(c.get("membership"), { name, cloud, writeBack, credentials: { clientId, clientSecret } });
        return c.json({ integration: created }, 201);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNameTaken) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .put("/:id/credentials", zValidator("json", credentialsBody), async (c) => {
      try {
        await integrations.rotateCredentials(c.get("membership"), c.req.param("id"), c.req.valid("json"));
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:id/pause", async (c) => {
      try {
        await integrations.setPaused(c.get("membership"), c.req.param("id"), true);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .post("/:id/resume", async (c) => {
      try {
        await integrations.setPaused(c.get("membership"), c.req.param("id"), false);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    })
    .put("/:id/write-back", zValidator("json", writeBackBody), async (c) => {
      try {
        await integrations.setWriteBack(c.get("membership"), c.req.param("id"), c.req.valid("json").enabled);
        return c.json({ ok: true }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof IntegrationNotFound) return c.json({ error: e.message }, 404);
        throw e;
      }
    });
