import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { NotPermitted } from "../access/policy";
import type { Deps } from "../deps";
import { type MemberEnv, requireMember } from "../members/membership";
import type { Modules } from "../modules";
import { InvalidSsoConfig, SsoDomainTaken, SsoNotEnabled } from "../sso/sso";

const idp = z.union([
  z.object({ metadataXml: z.string().trim().min(1).max(100_000) }),
  z.object({
    entityId: z.string().trim().min(1).max(1000),
    ssoUrl: z.string().trim().min(1).max(2000),
    certificate: z.string().trim().min(1).max(20_000),
  }),
]);
const ssoBody = z.object({ domain: z.string().trim().min(1).max(253), idp: idp.optional(), provisionAnalysts: z.boolean() });

const notPermitted = { error: "Not permitted" } as const;

/** The Organization's SAML single sign-on: every Member sees whether it's on; Admins configure and disable it. */
export const ssoRoutes = (deps: Deps, { sso }: Modules) =>
  new Hono<MemberEnv>()
    .use(requireMember(deps.db))
    .get("/", async (c) => c.json({ sso: await sso.get(c.get("membership")) }, 200))
    .put("/", zValidator("json", ssoBody), async (c) => {
      try {
        return c.json({ sso: await sso.configure(c.get("membership"), c.req.valid("json")) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof InvalidSsoConfig) return c.json({ error: e.message }, 400);
        if (e instanceof SsoDomainTaken) return c.json({ error: e.message }, 409);
        throw e;
      }
    })
    .delete("/", async (c) => {
      try {
        return c.json({ sso: await sso.disable(c.get("membership")) }, 200);
      } catch (e) {
        if (e instanceof NotPermitted) return c.json(notPermitted, 403);
        if (e instanceof SsoNotEnabled) return c.json({ error: e.message }, 404);
        throw e;
      }
    });
